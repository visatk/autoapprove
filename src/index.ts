import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";

export interface BroadcastJob {
  text: string;
  lastUserId: number;
}

export interface Env {
  BOT_TOKEN: string;
  WEBHOOK_SECRET?: string;
  ADMIN_USER_ID?: string;
  DB: D1Database;
  QUEUE: Queue<BroadcastJob>;
}

// Global variable to cache the Bot instance across worker invocations
let bot: Bot | null = null;

function getBot(env: Env): Bot {
  if (bot) return bot;
  
  bot = new Bot(env.BOT_TOKEN);
  
  // Add auto-retry middleware for handling rate limits
  bot.api.config.use(autoRetry());

  // Handle the /start command
  bot.command("start", async (ctx) => {
    const helpText = `
Welcome to the *Auto-Approve Bot*! 🚀

I can automatically approve join requests in your Telegram groups and channels.

*How to use:*
1. Add me to your group/channel as an Administrator.
2. Ensure I have the *"Invite Users via Link"* permission.
3. Enable *"Approve New Members"* in your chat settings.
4. I will take care of the rest!

*Developer Info:*
Developed by [@drkingbd](https://t.me/drkingbd)
`;
    await ctx.reply(helpText, { 
      parse_mode: "Markdown",
      disable_web_page_preview: true
    });
  });

  // Handle the /broadcast command (Admin only)
  bot.command("broadcast", async (ctx) => {
    if (!env.ADMIN_USER_ID || ctx.from?.id.toString() !== env.ADMIN_USER_ID) {
      return; // Unauthorized
    }

    if (!env.QUEUE) {
      await ctx.reply("❌ Broadcast queue is not bound. Please check wrangler.jsonc.", { parse_mode: "Markdown" });
      return;
    }

    const text = ctx.match;
    if (!text) {
      await ctx.reply("Please provide a message to broadcast. Usage: `/broadcast Hello everyone!`", { parse_mode: "Markdown" });
      return;
    }

    // Start the broadcast job by pushing to the queue with keyset pagination (lastUserId = 0)
    await env.QUEUE.send({ text, lastUserId: 0 });
    await ctx.reply("🚀 Broadcast started! Messages are being queued in the background.");
  });

  // Listen for chat join requests
  bot.on("chat_join_request", async (ctx) => {
    const chat = ctx.chatJoinRequest.chat;
    const user = ctx.chatJoinRequest.from;
    
    try {
      // Approve the request via Telegram API
      await ctx.approveChatJoinRequest(user.id);
      
      // Batch D1 queries for performance:
      const insertChat = env.DB.prepare(
        "INSERT OR IGNORE INTO chats (chat_id, title) VALUES (?, ?)"
      ).bind(chat.id, chat.title || "Private Group");

      const insertUser = env.DB.prepare(
        "INSERT INTO approved_users (user_id, chat_id) VALUES (?, ?)"
      ).bind(user.id, chat.id);

      // Execute both statements in a single round-trip (D1 transaction)
      await env.DB.batch([insertChat, insertUser]);

      console.log(`Approved user ${user.id} in chat ${chat.id}`);

      // Attempt to send a private welcome message to the user
      try {
        const welcomeMessage = `Hello ${user.first_name}! 👋\n\nYour request to join *${chat.title || "the group"}* has been automatically approved. Welcome!`;
        await ctx.api.sendMessage(user.id, welcomeMessage, { parse_mode: "Markdown" });
      } catch (msgError) {
        // Users might have blocked the bot, or Telegram might restrict messaging them.
        console.error(`Could not send private message to user ${user.id}:`, msgError);
      }

    } catch (error) {
      console.error(`Failed to process user ${user.id} in chat ${chat.id}:`, error);
    }
  });

  return bot;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    if (!env.BOT_TOKEN) {
      return new Response("BOT_TOKEN is not set", { status: 500 });
    }

    // Webhook Security Validation
    if (env.WEBHOOK_SECRET) {
      const secretToken = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (secretToken !== env.WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    try {
      const activeBot = getBot(env);
      const update = await request.json();

      // Background Execution
      ctx.waitUntil(
        activeBot.handleUpdate(update).catch((err) => {
          console.error("Error in handleUpdate:", err);
        })
      );

      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("Error parsing webhook JSON:", error);
      return new Response("Bad Request", { status: 400 });
    }
  },

  // Queue Consumer Handler
  async queue(batch: MessageBatch<BroadcastJob>, env: Env, ctx: ExecutionContext): Promise<void> {
    const activeBot = getBot(env);
    const BATCH_SIZE = 100; // Chunk size for D1 queries

    for (const message of batch.messages) {
      const { text, lastUserId } = message.body;

      try {
        // Fetch a chunk of users using keyset pagination (O(log N) performance thanks to the index)
        // Group by user_id to ensure we only message each user once.
        const { results } = await env.DB.prepare(
          `SELECT user_id FROM approved_users 
           WHERE user_id > ? 
           GROUP BY user_id 
           ORDER BY user_id ASC 
           LIMIT ?`
        ).bind(lastUserId, BATCH_SIZE).all<{ user_id: number }>();

        if (results && results.length > 0) {
          // Send messages to this chunk sequentially. 
          // Grammy's autoRetry will transparently handle Telegram's HTTP 429 Too Many Requests.
          for (const row of results) {
            try {
              await activeBot.api.sendMessage(row.user_id, text, { parse_mode: "Markdown" });
            } catch (err) {
              console.error(`Broadcast failed for user ${row.user_id}:`, err);
            }
          }

          // If we received a full batch, there might be more users.
          if (results.length === BATCH_SIZE) {
            const nextLastUserId = results[results.length - 1].user_id;
            await env.QUEUE.send({ text, lastUserId: nextLastUserId });
          } else {
            console.log(`Broadcast fully completed. Last processed user_id: ${results[results.length - 1].user_id}`);
          }
        } else {
          console.log(`Broadcast completed (no users found after user_id ${lastUserId})`);
        }

        // Acknowledge the message so it's not retried
        message.ack();
      } catch (error) {
        console.error("Queue processing error:", error);
        // Do not ack the message; let it retry if there was a DB failure.
        message.retry();
      }
    }
  }
};

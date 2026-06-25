import { Bot, Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";

export interface Env {
  BOT_TOKEN: string;
  WEBHOOK_SECRET?: string;
  DB: D1Database;
}

// Global variable to cache the Bot instance across worker invocations
// This prevents re-instantiation and re-attaching middleware on every request.
let bot: Bot | null = null;

function getBot(env: Env): Bot {
  if (bot) return bot;
  
  bot = new Bot(env.BOT_TOKEN);
  
  // Add auto-retry middleware for handling rate limits
  bot.api.config.use(autoRetry());

  // Listen for chat join requests
  bot.on("chat_join_request", async (ctx) => {
    const chat = ctx.chatJoinRequest.chat;
    const user = ctx.chatJoinRequest.from;
    
    try {
      // Approve the request via Telegram API
      await ctx.approveChatJoinRequest(user.id);
      
      // Batch D1 queries for performance:
      // 1. Ensure the chat exists in the DB
      // 2. Insert the user into the approved_users table
      const insertChat = env.DB.prepare(
        "INSERT OR IGNORE INTO chats (chat_id, title) VALUES (?, ?)"
      ).bind(chat.id, chat.title || "Private Group");

      const insertUser = env.DB.prepare(
        "INSERT INTO approved_users (user_id, chat_id) VALUES (?, ?)"
      ).bind(user.id, chat.id);

      // Execute both statements in a single round-trip (D1 transaction)
      await env.DB.batch([insertChat, insertUser]);

      console.log(`Approved user ${user.id} in chat ${chat.id}`);
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

      // Background Execution:
      // Tell Cloudflare to keep the isolate alive until handleUpdate finishes,
      // while we return a 200 OK to Telegram immediately.
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
};

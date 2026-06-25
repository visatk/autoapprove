-- D1 Database Schema for Auto-Approve Telegram Bot

CREATE TABLE IF NOT EXISTS chats (
    chat_id INTEGER PRIMARY KEY,
    title TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS approved_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    approved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES chats (chat_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_approved_users_chat_id ON approved_users (chat_id);
CREATE INDEX IF NOT EXISTS idx_approved_users_user_id ON approved_users (user_id);

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface Message {
  id: string;
  channel_id: string;
  type: string;
  sender_repo: string;
  content: string;
  metadata: string;
  is_pinned: number;
  is_compressed: number;
  created_at: string;
}

export interface PostMessageInput {
  channel: string;
  content: string;
  sender_repo: string;
  type?: "chat" | "decision" | "convention" | "correction" | "handoff" | "task";
  pin?: boolean;
  metadata?: Record<string, unknown>;
}

export interface CheckMessagesInput {
  channel?: string;
  since?: string;
}

const AUTO_PIN_TYPES = new Set(["convention"]);

export function postMessage(
  db: Database.Database,
  input: PostMessageInput
): Message {
  const id = randomUUID();
  const type = input.type ?? "chat";
  const isPinned = input.pin || AUTO_PIN_TYPES.has(type) ? 1 : 0;
  const metadata = input.metadata ? JSON.stringify(input.metadata) : "{}";

  db.prepare(
    `INSERT INTO messages (id, channel_id, type, sender_repo, content, metadata, is_pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.channel, type, input.sender_repo, input.content, metadata, isPinned);

  // Update last_read_at for the sender (they've seen their own message)
  db.prepare(
    `UPDATE channel_repos SET last_read_at = datetime('now')
     WHERE channel_id = ? AND repo_path = ?`
  ).run(input.channel, input.sender_repo);

  return db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Message;
}

export function checkMessages(
  db: Database.Database,
  input: CheckMessagesInput
): Message[] {
  if (input.channel) {
    return db
      .prepare(
        `SELECT * FROM messages
         WHERE channel_id = ? AND created_at > ?
         ORDER BY created_at ASC`
      )
      .all(input.channel, input.since ?? "1970-01-01") as Message[];
  }

  return db
    .prepare(
      `SELECT * FROM messages WHERE created_at > ? ORDER BY created_at ASC`
    )
    .all(input.since ?? "1970-01-01") as Message[];
}

export function getNewMessageNotifications(
  db: Database.Database,
  repoPath: string
): Message[] {
  const repos = db
    .prepare(
      "SELECT channel_id, last_read_at FROM channel_repos WHERE repo_path = ?"
    )
    .all(repoPath) as { channel_id: string; last_read_at: string }[];

  const messages: Message[] = [];

  for (const repo of repos) {
    const newMsgs = db
      .prepare(
        `SELECT * FROM messages
         WHERE channel_id = ? AND created_at > ? AND sender_repo != ?
         ORDER BY created_at ASC`
      )
      .all(repo.channel_id, repo.last_read_at, repoPath) as Message[];

    messages.push(...newMsgs);
  }

  return messages;
}

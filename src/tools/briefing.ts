import type Database from "better-sqlite3";
import type { Message } from "./messaging.js";

export interface Summary {
  id: string;
  channel_id: string;
  content: string;
  message_count: number;
  period_start: string;
  period_end: string;
  created_at: string;
}

export interface ChannelBriefing {
  channel: {
    id: string;
    description: string;
    context_budget: number;
    member_count: number;
    total_messages: number;
  };
  pinned: Message[];
  recent: Message[];
  summaries: Summary[];
}

export function joinChannel(
  db: Database.Database,
  channelName: string,
  repoPath: string
): ChannelBriefing {
  const channel = db
    .prepare("SELECT * FROM channels WHERE id = ?")
    .get(channelName) as any;
  if (!channel) {
    throw new Error(`Channel '${channelName}' does not exist`);
  }

  const memberCount = (
    db
      .prepare(
        "SELECT COUNT(*) as cnt FROM channel_repos WHERE channel_id = ?"
      )
      .get(channelName) as any
  ).cnt;

  const totalMessages = (
    db
      .prepare("SELECT COUNT(*) as cnt FROM messages WHERE channel_id = ?")
      .get(channelName) as any
  ).cnt;

  // Layer 2: Pinned messages (always included)
  const pinned = db
    .prepare(
      "SELECT * FROM messages WHERE channel_id = ? AND is_pinned = 1 ORDER BY created_at ASC"
    )
    .all(channelName) as Message[];

  // Layer 3: Recent uncompressed messages
  // Simple heuristic: ~4 tokens per word, ~10 words per message ≈ 40 tokens/msg
  // Reserve 50% of budget for recent messages after pins
  const budgetForRecent = Math.floor(channel.context_budget * 0.5);
  const estimatedMsgLimit = Math.max(5, Math.floor(budgetForRecent / 40));

  const recent = db
    .prepare(
      `SELECT * FROM messages
       WHERE channel_id = ? AND is_compressed = 0 AND is_pinned = 0
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(channelName, estimatedMsgLimit) as Message[];

  // Reverse to chronological order
  recent.reverse();

  // Layer 4: Summaries (oldest first)
  const summaries = db
    .prepare(
      "SELECT * FROM summaries WHERE channel_id = ? ORDER BY period_start ASC"
    )
    .all(channelName) as Summary[];

  // Update last_read_at for this repo
  db.prepare(
    "UPDATE channel_repos SET last_read_at = datetime('now') WHERE channel_id = ? AND repo_path = ?"
  ).run(channelName, repoPath);

  return {
    channel: {
      id: channel.id,
      description: channel.description,
      context_budget: channel.context_budget,
      member_count: memberCount,
      total_messages: totalMessages,
    },
    pinned,
    recent,
    summaries,
  };
}

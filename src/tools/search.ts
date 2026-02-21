import type Database from "better-sqlite3";
import type { Message } from "./messaging.js";
import { buildFtsQuery } from "../utils/search.js";

export interface SearchInput {
  query: string;
  channel?: string;
  type?: string;
  limit?: number;
}

export function searchChannel(
  db: Database.Database,
  input: SearchInput
): Message[] {
  const ftsQuery = buildFtsQuery(input.query);
  if (!ftsQuery) return [];

  const limit = input.limit ?? 20;
  let sql = `
    SELECT m.* FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    WHERE messages_fts MATCH ?
  `;
  const params: unknown[] = [ftsQuery];

  if (input.channel) {
    sql += " AND m.channel_id = ?";
    params.push(input.channel);
  }

  if (input.type) {
    sql += " AND m.type = ?";
    params.push(input.type);
  }

  sql += " ORDER BY bm25(messages_fts) LIMIT ?";
  params.push(limit);

  return db.prepare(sql).all(...params) as Message[];
}

export function pinMessage(
  db: Database.Database,
  messageId: string
): Message {
  const msg = db
    .prepare("SELECT * FROM messages WHERE id = ?")
    .get(messageId) as Message | undefined;
  if (!msg) {
    throw new Error(`Message '${messageId}' not found`);
  }

  db.prepare("UPDATE messages SET is_pinned = 1 WHERE id = ?").run(messageId);
  return db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as Message;
}

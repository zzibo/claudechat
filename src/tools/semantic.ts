import type Database from "better-sqlite3";
import { addToVectorStore, semanticSearch, VectorEntry } from "../db/vectors.js";

/**
 * Index unindexed messages into the vector store.
 * Reads messages from SQLite that haven't been vectorized yet,
 * adds them to ChromaDB, and marks them as indexed.
 */
export async function indexMessages(db: Database.Database): Promise<number> {
  const unindexed = db
    .prepare(
      `SELECT id, channel_id, content, sender_repo, type, created_at
       FROM messages
       WHERE is_compressed = 0 AND id NOT IN (
         SELECT message_id FROM vector_index_log
       )
       ORDER BY created_at ASC
       LIMIT 100`
    )
    .all() as any[];

  if (unindexed.length === 0) return 0;

  const entries: VectorEntry[] = unindexed.map((msg) => ({
    id: msg.id,
    content: msg.content,
    metadata: {
      channel_id: msg.channel_id,
      sender_repo: msg.sender_repo,
      type: msg.type,
      created_at: msg.created_at,
    },
  }));

  await addToVectorStore(entries);

  // Mark as indexed
  const insert = db.prepare(
    "INSERT OR IGNORE INTO vector_index_log (message_id) VALUES (?)"
  );
  const markIndexed = db.transaction((ids: string[]) => {
    for (const id of ids) insert.run(id);
  });
  markIndexed(unindexed.map((m) => m.id));

  return unindexed.length;
}

/**
 * Search messages by semantic similarity rather than keyword matching.
 */
export async function semanticSearchMessages(
  query: string,
  opts?: { channel?: string; limit?: number }
): Promise<VectorEntry[]> {
  return semanticSearch(query, opts);
}

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../src/db/schema.js";

// Mock chromadb before importing semantic tools
vi.mock("chromadb", () => {
  const store: Map<string, { document: string; metadata: any }> = new Map();

  return {
    ChromaClient: vi.fn().mockImplementation(() => ({
      getOrCreateCollection: vi.fn().mockResolvedValue({
        add: vi.fn().mockImplementation(async ({ ids, documents, metadatas }) => {
          ids.forEach((id: string, i: number) => {
            store.set(id, { document: documents[i], metadata: metadatas[i] });
          });
        }),
        query: vi.fn().mockImplementation(async ({ queryTexts, nResults }) => {
          const entries = Array.from(store.entries()).slice(0, nResults);
          return {
            ids: [entries.map(([id]) => id)],
            documents: [entries.map(([, v]) => v.document)],
            metadatas: [entries.map(([, v]) => v.metadata)],
          };
        }),
      }),
    })),
  };
});

describe("Semantic Search", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);

    // Add the vector_index_log table (from vector schema migration)
    db.exec(`
      CREATE TABLE IF NOT EXISTS vector_index_log (
        message_id TEXT PRIMARY KEY,
        indexed_at TEXT DEFAULT (datetime('now'))
      )
    `);
  });

  afterEach(() => {
    db.close();
  });

  it("should index unindexed messages", async () => {
    const { indexMessages } = await import("../../src/tools/semantic.js");

    // Create a channel and some messages
    db.prepare("INSERT INTO channels (id, description) VALUES (?, ?)").run(
      "test",
      "Test channel"
    );

    db.prepare(
      `INSERT INTO messages (id, channel_id, content, sender_repo, type)
       VALUES (?, ?, ?, ?, ?)`
    ).run("msg-1", "test", "Hello world", "/repo", "chat");

    db.prepare(
      `INSERT INTO messages (id, channel_id, content, sender_repo, type)
       VALUES (?, ?, ?, ?, ?)`
    ).run("msg-2", "test", "How are you", "/repo", "chat");

    const count = await indexMessages(db);
    expect(count).toBe(2);

    // Verify they're marked as indexed
    const indexed = db
      .prepare("SELECT COUNT(*) as cnt FROM vector_index_log")
      .get() as any;
    expect(indexed.cnt).toBe(2);
  });

  it("should not re-index already indexed messages", async () => {
    const { indexMessages } = await import("../../src/tools/semantic.js");

    db.prepare("INSERT INTO channels (id, description) VALUES (?, ?)").run(
      "test",
      "Test channel"
    );

    db.prepare(
      `INSERT INTO messages (id, channel_id, content, sender_repo, type)
       VALUES (?, ?, ?, ?, ?)`
    ).run("msg-1", "test", "Hello", "/repo", "chat");

    await indexMessages(db);
    const secondCount = await indexMessages(db);
    expect(secondCount).toBe(0);
  });

  it("should return results from semantic search", async () => {
    const { semanticSearchMessages } = await import(
      "../../src/tools/semantic.js"
    );

    const results = await semanticSearchMessages("hello");
    expect(Array.isArray(results)).toBe(true);
  });
});

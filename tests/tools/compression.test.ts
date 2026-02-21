import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../src/db/schema.js";
import { createChannel } from "../../src/tools/channels.js";
import {
  compressChannel,
  extractActionLines,
} from "../../src/tools/compression.js";

describe("Compression Engine", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    createChannel(db, "test-ch", "test");
  });

  afterEach(() => {
    db.close();
  });

  describe("extractActionLines", () => {
    it("extracts verb-first lines", () => {
      const lines = extractActionLines([
        "Added auth middleware",
        "working on it",
        "Fixed token refresh bug",
        "just chatting",
        "Updated the API docs",
      ]);
      expect(lines).toContain("Added auth middleware");
      expect(lines).toContain("Fixed token refresh bug");
      expect(lines).toContain("Updated the API docs");
    });

    it("extracts lines with key patterns", () => {
      const lines = extractActionLines([
        "Auth system done",
        "Merged PR #42",
        "random message",
      ]);
      expect(lines).toContain("Auth system done");
      expect(lines).toContain("Merged PR #42");
    });

    it("returns empty for non-action lines", () => {
      const lines = extractActionLines([
        "just chatting",
        "thinking about it",
        "hmm",
      ]);
      expect(lines.length).toBe(0);
    });
  });

  describe("compressChannel", () => {
    it("does nothing when below threshold", () => {
      for (let i = 0; i < 3; i++) {
        db.prepare(
          `INSERT INTO messages (id, channel_id, type, sender_repo, content, created_at)
           VALUES (?, 'test-ch', 'chat', '/repo', ?, datetime('now', '-2 days'))`
        ).run(`m${i}`, `Added feature ${i}`);
      }
      const result = compressChannel(db, "test-ch");
      expect(result.compressed).toBe(0);
    });

    it("compresses old messages above threshold", () => {
      for (let i = 0; i < 55; i++) {
        db.prepare(
          `INSERT INTO messages (id, channel_id, type, sender_repo, content, created_at)
           VALUES (?, 'test-ch', 'chat', '/repo', ?, datetime('now', '-3 days'))`
        ).run(`m${i}`, `Added feature ${i}`);
      }
      const result = compressChannel(db, "test-ch");
      expect(result.compressed).toBeGreaterThan(0);

      const summaries = db
        .prepare("SELECT * FROM summaries WHERE channel_id = 'test-ch'")
        .all();
      expect(summaries.length).toBeGreaterThan(0);

      const compressed = db
        .prepare(
          "SELECT COUNT(*) as cnt FROM messages WHERE channel_id = 'test-ch' AND is_compressed = 1"
        )
        .get() as any;
      expect(compressed.cnt).toBeGreaterThan(0);
    });

    it("never compresses pinned messages", () => {
      for (let i = 0; i < 55; i++) {
        db.prepare(
          `INSERT INTO messages (id, channel_id, type, sender_repo, content, is_pinned, created_at)
           VALUES (?, 'test-ch', 'chat', '/repo', ?, ?, datetime('now', '-3 days'))`
        ).run(`m${i}`, `Message ${i}`, i === 0 ? 1 : 0);
      }
      compressChannel(db, "test-ch");
      const pinned = db
        .prepare("SELECT * FROM messages WHERE id = 'm0'")
        .get() as any;
      expect(pinned.is_compressed).toBe(0);
    });

    it("never compresses decision/convention/correction types", () => {
      for (let i = 0; i < 55; i++) {
        const type = i === 0 ? "decision" : "chat";
        db.prepare(
          `INSERT INTO messages (id, channel_id, type, sender_repo, content, created_at)
           VALUES (?, 'test-ch', ?, '/repo', ?, datetime('now', '-3 days'))`
        ).run(`m${i}`, type, `Message ${i}`);
      }
      compressChannel(db, "test-ch");
      const decision = db
        .prepare("SELECT * FROM messages WHERE id = 'm0'")
        .get() as any;
      expect(decision.is_compressed).toBe(0);
    });
  });
});

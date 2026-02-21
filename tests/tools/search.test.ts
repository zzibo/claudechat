import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../src/db/schema.js";
import { createChannel } from "../../src/tools/channels.js";
import { postMessage } from "../../src/tools/messaging.js";
import { searchChannel, pinMessage } from "../../src/tools/search.js";

describe("Search & Pin", () => {
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

  describe("searchChannel", () => {
    it("finds messages by content", () => {
      postMessage(db, {
        channel: "test-ch",
        content: "JWT authentication setup",
        sender_repo: "/repo",
      });
      postMessage(db, {
        channel: "test-ch",
        content: "React component styling",
        sender_repo: "/repo",
      });
      const results = searchChannel(db, { query: "authentication" });
      expect(results.length).toBe(1);
      expect(results[0].content).toContain("JWT");
    });

    it("filters by channel", () => {
      createChannel(db, "other", "other");
      postMessage(db, {
        channel: "test-ch",
        content: "hello world",
        sender_repo: "/repo",
      });
      postMessage(db, {
        channel: "other",
        content: "hello world",
        sender_repo: "/repo",
      });
      const results = searchChannel(db, {
        query: "hello",
        channel: "test-ch",
      });
      expect(results.length).toBe(1);
      expect(results[0].channel_id).toBe("test-ch");
    });

    it("filters by message type", () => {
      postMessage(db, {
        channel: "test-ch",
        content: "Use JWT",
        sender_repo: "/repo",
        type: "decision",
      });
      postMessage(db, {
        channel: "test-ch",
        content: "JWT token refresh",
        sender_repo: "/repo",
        type: "chat",
      });
      const results = searchChannel(db, {
        query: "JWT",
        type: "decision",
      });
      expect(results.length).toBe(1);
      expect(results[0].type).toBe("decision");
    });

    it("returns empty on no match", () => {
      postMessage(db, {
        channel: "test-ch",
        content: "hello",
        sender_repo: "/repo",
      });
      const results = searchChannel(db, { query: "nonexistent" });
      expect(results.length).toBe(0);
    });
  });

  describe("pinMessage", () => {
    it("pins a message", () => {
      const msg = postMessage(db, {
        channel: "test-ch",
        content: "important",
        sender_repo: "/repo",
      });
      expect(msg.is_pinned).toBe(0);
      const pinned = pinMessage(db, msg.id);
      expect(pinned.is_pinned).toBe(1);
    });

    it("throws if message not found", () => {
      expect(() => pinMessage(db, "nonexistent")).toThrow();
    });
  });
});

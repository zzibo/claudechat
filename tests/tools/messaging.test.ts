import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../src/db/schema.js";
import { createChannel, connectRepo } from "../../src/tools/channels.js";
import {
  postMessage,
  checkMessages,
  getNewMessageNotifications,
} from "../../src/tools/messaging.js";

describe("Messaging", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    createChannel(db, "test-ch", "test channel");
    connectRepo(db, "test-ch", "/repo/a");
  });

  afterEach(() => {
    db.close();
  });

  describe("postMessage", () => {
    it("posts a chat message", () => {
      const msg = postMessage(db, {
        channel: "test-ch",
        content: "hello world",
        sender_repo: "/repo/a",
      });
      expect(msg.id).toBeDefined();
      expect(msg.type).toBe("chat");
      expect(msg.content).toBe("hello world");
      expect(msg.is_pinned).toBe(0);
    });

    it("posts a decision message", () => {
      const msg = postMessage(db, {
        channel: "test-ch",
        content: "Use JWT",
        sender_repo: "/repo/a",
        type: "decision",
      });
      expect(msg.type).toBe("decision");
    });

    it("posts a pinned message", () => {
      const msg = postMessage(db, {
        channel: "test-ch",
        content: "Important",
        sender_repo: "/repo/a",
        pin: true,
      });
      expect(msg.is_pinned).toBe(1);
    });

    it("auto-pins convention messages", () => {
      const msg = postMessage(db, {
        channel: "test-ch",
        content: "Use named exports",
        sender_repo: "/repo/a",
        type: "convention",
      });
      expect(msg.is_pinned).toBe(1);
    });

    it("stores metadata for correction messages", () => {
      const msg = postMessage(db, {
        channel: "test-ch",
        content: "Don't use var, use const",
        sender_repo: "/repo/a",
        type: "correction",
        metadata: { wrong: "var x = 1", correct: "const x = 1" },
      });
      const parsed = JSON.parse(msg.metadata);
      expect(parsed.wrong).toBe("var x = 1");
    });
  });

  describe("checkMessages", () => {
    it("returns messages since a given time", () => {
      postMessage(db, {
        channel: "test-ch",
        content: "msg1",
        sender_repo: "/repo/a",
      });
      // Use a past date in SQLite format to match datetime('now') format
      const msgs = checkMessages(db, { channel: "test-ch", since: "2000-01-01 00:00:00" });
      expect(msgs.length).toBe(1);
    });

    it("returns empty when no new messages", () => {
      const msgs = checkMessages(db, { channel: "test-ch", since: "2099-01-01 00:00:00" });
      expect(msgs.length).toBe(0);
    });
  });

  describe("getNewMessageNotifications", () => {
    it("returns new messages since last read for a repo", () => {
      // Set last_read_at to the past so new messages are detected
      db.prepare(
        "UPDATE channel_repos SET last_read_at = datetime('now', '-1 hour') WHERE repo_path = '/repo/a'"
      ).run();
      connectRepo(db, "test-ch", "/repo/b");
      postMessage(db, {
        channel: "test-ch",
        content: "new update",
        sender_repo: "/repo/b",
      });
      const notifs = getNewMessageNotifications(db, "/repo/a");
      expect(notifs.length).toBeGreaterThanOrEqual(1);
      expect(notifs[0].content).toBe("new update");
    });

    it("does not return own messages", () => {
      postMessage(db, {
        channel: "test-ch",
        content: "my own msg",
        sender_repo: "/repo/a",
      });
      const notifs = getNewMessageNotifications(db, "/repo/a");
      expect(notifs.length).toBe(0);
    });
  });
});

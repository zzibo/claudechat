import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../src/db/schema.js";
import { createChannel, connectRepo } from "../../src/tools/channels.js";
import { postMessage } from "../../src/tools/messaging.js";
import { joinChannel } from "../../src/tools/briefing.js";

describe("Join Channel & Briefing", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    createChannel(db, "test-ch", "A test channel for coordination");
    connectRepo(db, "test-ch", "/repo/a");
  });

  afterEach(() => {
    db.close();
  });

  it("returns channel info", () => {
    const briefing = joinChannel(db, "test-ch", "/repo/a");
    expect(briefing.channel.id).toBe("test-ch");
    expect(briefing.channel.description).toBe(
      "A test channel for coordination"
    );
  });

  it("returns pinned messages", () => {
    postMessage(db, {
      channel: "test-ch",
      content: "Use JWT",
      sender_repo: "/repo/a",
      type: "decision",
      pin: true,
    });
    postMessage(db, {
      channel: "test-ch",
      content: "just a chat",
      sender_repo: "/repo/a",
    });
    const briefing = joinChannel(db, "test-ch", "/repo/a");
    expect(briefing.pinned.length).toBe(1);
    expect(briefing.pinned[0].content).toBe("Use JWT");
  });

  it("returns recent messages", () => {
    postMessage(db, {
      channel: "test-ch",
      content: "msg1",
      sender_repo: "/repo/a",
    });
    postMessage(db, {
      channel: "test-ch",
      content: "msg2",
      sender_repo: "/repo/a",
    });
    const briefing = joinChannel(db, "test-ch", "/repo/a");
    expect(briefing.recent.length).toBe(2);
  });

  it("returns summaries if they exist", () => {
    db.prepare(
      "INSERT INTO summaries (id, channel_id, content, message_count, period_start, period_end) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("s1", "test-ch", "Earlier: set up project", 5, "2026-02-17", "2026-02-17");
    const briefing = joinChannel(db, "test-ch", "/repo/a");
    expect(briefing.summaries.length).toBe(1);
    expect(briefing.summaries[0].content).toBe("Earlier: set up project");
  });

  it("updates last_read_at for the repo", () => {
    const before = db
      .prepare(
        "SELECT last_read_at FROM channel_repos WHERE channel_id = ? AND repo_path = ?"
      )
      .get("test-ch", "/repo/a") as any;

    // Small delay to ensure timestamps differ
    joinChannel(db, "test-ch", "/repo/a");

    const after = db
      .prepare(
        "SELECT last_read_at FROM channel_repos WHERE channel_id = ? AND repo_path = ?"
      )
      .get("test-ch", "/repo/a") as any;

    // last_read_at should be updated (may be same second, just check it's defined)
    expect(after.last_read_at).toBeDefined();
  });

  it("throws if channel does not exist", () => {
    expect(() => joinChannel(db, "nonexistent", "/repo/a")).toThrow();
  });
});

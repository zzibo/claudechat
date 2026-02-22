import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../src/db/schema.js";
import {
  createChannel,
  listChannels,
  connectRepo,
  disconnectRepo,
  syncChannel,
} from "../../src/tools/channels.js";

describe("Channel Management", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("createChannel", () => {
    it("creates a channel with default budget", () => {
      const ch = createChannel(db, "test-channel", "A test channel");
      expect(ch.id).toBe("test-channel");
      expect(ch.description).toBe("A test channel");
      expect(ch.context_budget).toBe(4000);
      expect(ch.repos).toEqual([]);
    });

    it("creates a channel with custom budget", () => {
      const ch = createChannel(db, "big", "Big channel", 8000);
      expect(ch.context_budget).toBe(8000);
    });

    it("throws on duplicate name", () => {
      createChannel(db, "dup", "first");
      expect(() => createChannel(db, "dup", "second")).toThrow();
    });
  });

  describe("listChannels", () => {
    it("returns empty array when no channels", () => {
      expect(listChannels(db)).toEqual([]);
    });

    it("returns channels with repos", () => {
      createChannel(db, "ch1", "Channel 1");
      connectRepo(db, "ch1", "/repo/a");
      const channels = listChannels(db);
      expect(channels.length).toBe(1);
      expect(channels[0].id).toBe("ch1");
      expect(channels[0].repos).toContain("/repo/a");
    });
  });

  describe("connectRepo", () => {
    it("connects a repo to a channel", () => {
      createChannel(db, "ch", "test");
      connectRepo(db, "ch", "/my/repo");
      const channels = listChannels(db);
      expect(channels[0].repos).toContain("/my/repo");
    });

    it("throws if channel does not exist", () => {
      expect(() => connectRepo(db, "nope", "/repo")).toThrow();
    });

    it("ignores duplicate connections", () => {
      createChannel(db, "ch", "test");
      connectRepo(db, "ch", "/repo");
      connectRepo(db, "ch", "/repo");
      const channels = listChannels(db);
      expect(channels[0].repos.length).toBe(1);
    });
  });

  describe("disconnectRepo", () => {
    it("removes a repo from a channel", () => {
      createChannel(db, "ch", "test");
      connectRepo(db, "ch", "/repo");
      disconnectRepo(db, "ch", "/repo");
      const channels = listChannels(db);
      expect(channels[0].repos.length).toBe(0);
    });
  });

  describe("syncChannel", () => {
    it("creates channel and connects repo if neither exist", () => {
      const name = syncChannel(db, "/Users/zibo/my-project");
      expect(name).toBe("my-project");
      const channels = listChannels(db);
      expect(channels.length).toBe(1);
      expect(channels[0].id).toBe("my-project");
      expect(channels[0].repos).toContain("/Users/zibo/my-project");
    });

    it("reuses existing channel on second call", () => {
      syncChannel(db, "/Users/zibo/my-project");
      syncChannel(db, "/Users/zibo/my-project");
      const channels = listChannels(db);
      expect(channels.length).toBe(1);
      expect(channels[0].repos.length).toBe(1);
    });

    it("connects a second repo to the same channel name", () => {
      syncChannel(db, "/Users/alice/my-project");
      syncChannel(db, "/Users/bob/my-project");
      const channels = listChannels(db);
      expect(channels.length).toBe(1);
      expect(channels[0].repos.length).toBe(2);
    });

    it("derives channel name from last path segment", () => {
      expect(syncChannel(db, "/a/b/c/deep-repo")).toBe("deep-repo");
      expect(syncChannel(db, "/single")).toBe("single");
    });

    it("falls back to 'default' for empty path", () => {
      expect(syncChannel(db, "")).toBe("default");
    });
  });
});

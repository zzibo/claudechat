import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../src/db/schema.js";

describe("Schema v2", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
  });

  afterEach(() => {
    db.close();
  });

  it("creates all required tables", () => {
    applySchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);

    expect(tables).toContain("schema_version");
    expect(tables).toContain("channels");
    expect(tables).toContain("channel_repos");
    expect(tables).toContain("messages");
    expect(tables).toContain("summaries");
  });

  it("creates FTS5 virtual table for messages", () => {
    applySchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);

    expect(tables).toContain("messages_fts");
  });

  it("is idempotent", () => {
    applySchema(db);
    expect(() => applySchema(db)).not.toThrow();
  });

  it("sets schema version to 2", () => {
    applySchema(db);
    const row = db.prepare("SELECT version FROM schema_version").get() as any;
    expect(row.version).toBe(2);
  });

  it("channels table has context_budget column", () => {
    applySchema(db);
    db.prepare("INSERT INTO channels (id, description) VALUES ('test', 'test channel')").run();
    const row = db.prepare("SELECT context_budget FROM channels WHERE id = 'test'").get() as any;
    expect(row.context_budget).toBe(4000);
  });

  it("channel_repos table has last_read_at column", () => {
    applySchema(db);
    db.prepare("INSERT INTO channels (id, description) VALUES ('test', 'test')").run();
    db.prepare("INSERT INTO channel_repos (channel_id, repo_path) VALUES ('test', '/foo')").run();
    const row = db.prepare("SELECT last_read_at FROM channel_repos WHERE channel_id = 'test'").get() as any;
    expect(row.last_read_at).toBeDefined();
  });

  it("messages table enforces type check constraint", () => {
    applySchema(db);
    db.prepare("INSERT INTO channels (id, description) VALUES ('test', 'test')").run();
    expect(() => {
      db.prepare(
        "INSERT INTO messages (id, channel_id, type, sender_repo, content) VALUES ('m1', 'test', 'invalid', '/foo', 'hello')"
      ).run();
    }).toThrow();
  });

  it("FTS5 triggers sync on insert", () => {
    applySchema(db);
    db.prepare("INSERT INTO channels (id, description) VALUES ('test', 'test')").run();
    db.prepare(
      "INSERT INTO messages (id, channel_id, type, sender_repo, content) VALUES ('m1', 'test', 'chat', '/foo', 'hello world test')"
    ).run();
    const results = db
      .prepare("SELECT * FROM messages_fts WHERE messages_fts MATCH 'hello'")
      .all();
    expect(results.length).toBe(1);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../src/db/schema.js";

describe("Database Schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
  });

  afterEach(() => {
    db.close();
  });

  it("creates all required tables", () => {
    applySchema(db);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("spaces");
    expect(tableNames).toContain("memories");
    expect(tableNames).toContain("memory_versions");
    expect(tableNames).toContain("space_repos");
    expect(tableNames).toContain("handoffs");
    expect(tableNames).toContain("corrections");
  });

  it("creates FTS5 virtual tables", () => {
    applySchema(db);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts%' ORDER BY name"
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("memories_fts");
    expect(tableNames).toContain("corrections_fts");
  });

  it("is idempotent — running twice does not error", () => {
    applySchema(db);
    expect(() => applySchema(db)).not.toThrow();
  });

  it("creates schema_version table with version 1", () => {
    applySchema(db);
    const row = db.prepare("SELECT version FROM schema_version").get() as {
      version: number;
    };
    expect(row.version).toBe(1);
  });
});

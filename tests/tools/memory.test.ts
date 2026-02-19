import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../src/db/schema.js";
import { createSpace } from "../../src/tools/spaces.js";
import {
  writeMemory,
  recall,
  updateMemory,
  deleteMemory,
} from "../../src/tools/memory.js";

describe("Memory Tools", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    createSpace(db, "test-space", "Test space");
  });

  afterEach(() => {
    db.close();
  });

  describe("writeMemory", () => {
    it("creates a memory and returns it", () => {
      const mem = writeMemory(db, {
        space: "test-space",
        category: "convention",
        title: "Use camelCase",
        content: "Always use camelCase for variable names",
        source_repo: "/path/to/repo",
      });

      expect(mem.id).toBeDefined();
      expect(mem.title).toBe("Use camelCase");
      expect(mem.space_id).toBe("test-space");
    });

    it("stores tags as comma-separated string", () => {
      const mem = writeMemory(db, {
        space: "test-space",
        category: "convention",
        title: "Test",
        content: "Content",
        source_repo: "/repo",
        tags: "typescript,naming",
      });

      expect(mem.tags).toBe("typescript,naming");
    });
  });

  describe("recall", () => {
    it("finds memories by keyword search", () => {
      writeMemory(db, {
        space: "test-space",
        category: "context",
        title: "Fixed JWT auth bug",
        content: "The JWT token was expiring too early due to clock skew",
        source_repo: "/payments",
      });

      writeMemory(db, {
        space: "test-space",
        category: "convention",
        title: "CSS naming convention",
        content: "Use BEM methodology for all CSS classes",
        source_repo: "/frontend",
      });

      const results = recall(db, { query: "JWT auth bug" });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toContain("JWT");
    });

    it("returns empty array for no matches", () => {
      const results = recall(db, { query: "nonexistent xyzzy" });
      expect(results).toEqual([]);
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        writeMemory(db, {
          space: "test-space",
          category: "context",
          title: `Memory ${i}`,
          content: `This is test memory number ${i} about search`,
          source_repo: "/repo",
        });
      }

      const results = recall(db, { query: "search", limit: 3 });
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it("filters by space", () => {
      createSpace(db, "other-space", "Other");
      writeMemory(db, {
        space: "test-space",
        category: "context",
        title: "Test space memory",
        content: "This is in test space about databases",
        source_repo: "/repo",
      });
      writeMemory(db, {
        space: "other-space",
        category: "context",
        title: "Other space memory",
        content: "This is in other space about databases",
        source_repo: "/repo",
      });

      const results = recall(db, { query: "databases", space: "test-space" });
      expect(results.every((r) => r.space_id === "test-space")).toBe(true);
    });
  });

  describe("updateMemory", () => {
    it("updates content and creates a version", () => {
      const mem = writeMemory(db, {
        space: "test-space",
        category: "convention",
        title: "Original title",
        content: "Original content",
        source_repo: "/repo",
      });

      const updated = updateMemory(db, mem.id, {
        title: "Updated title",
        content: "Updated content",
      });

      expect(updated.title).toBe("Updated title");
      expect(updated.content).toBe("Updated content");

      const versions = db
        .prepare("SELECT * FROM memory_versions WHERE memory_id = ?")
        .all(mem.id) as { title: string; content: string }[];
      expect(versions).toHaveLength(1);
      expect(versions[0].title).toBe("Original title");
      expect(versions[0].content).toBe("Original content");
    });
  });

  describe("deleteMemory", () => {
    it("removes a memory", () => {
      const mem = writeMemory(db, {
        space: "test-space",
        category: "context",
        title: "To be deleted",
        content: "Content",
        source_repo: "/repo",
      });

      deleteMemory(db, mem.id);

      const row = db
        .prepare("SELECT * FROM memories WHERE id = ?")
        .get(mem.id);
      expect(row).toBeUndefined();
    });
  });
});

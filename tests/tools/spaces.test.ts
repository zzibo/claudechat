import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../src/db/schema.js";
import {
  createSpace,
  listSpaces,
  addRepoToSpace,
  removeRepoFromSpace,
} from "../../src/tools/spaces.js";

describe("Space Management", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("createSpace", () => {
    it("creates a space and returns it", () => {
      const result = createSpace(db, "project-alpha", "My test project");
      expect(result.id).toBe("project-alpha");
      expect(result.description).toBe("My test project");
    });

    it("throws on duplicate space name", () => {
      createSpace(db, "project-alpha", "First");
      expect(() => createSpace(db, "project-alpha", "Second")).toThrow();
    });
  });

  describe("listSpaces", () => {
    it("returns empty array when no spaces exist", () => {
      expect(listSpaces(db)).toEqual([]);
    });

    it("returns spaces with their repos", () => {
      createSpace(db, "space-1", "Space one");
      addRepoToSpace(db, "space-1", "/path/to/repo-a");
      addRepoToSpace(db, "space-1", "/path/to/repo-b");

      const spaces = listSpaces(db);
      expect(spaces).toHaveLength(1);
      expect(spaces[0].id).toBe("space-1");
      expect(spaces[0].repos).toContain("/path/to/repo-a");
      expect(spaces[0].repos).toContain("/path/to/repo-b");
    });
  });

  describe("addRepoToSpace", () => {
    it("links a repo to a space", () => {
      createSpace(db, "space-1", "Space one");
      addRepoToSpace(db, "space-1", "/path/to/repo");

      const spaces = listSpaces(db);
      expect(spaces[0].repos).toContain("/path/to/repo");
    });

    it("throws if space does not exist", () => {
      expect(() =>
        addRepoToSpace(db, "nonexistent", "/path/to/repo")
      ).toThrow();
    });
  });

  describe("removeRepoFromSpace", () => {
    it("unlinks a repo from a space", () => {
      createSpace(db, "space-1", "Space one");
      addRepoToSpace(db, "space-1", "/path/to/repo");
      removeRepoFromSpace(db, "space-1", "/path/to/repo");

      const spaces = listSpaces(db);
      expect(spaces[0].repos).toHaveLength(0);
    });
  });
});

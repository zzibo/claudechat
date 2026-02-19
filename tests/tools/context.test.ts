import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../src/db/schema.js";
import { createSpace, addRepoToSpace } from "../../src/tools/spaces.js";
import { writeMemory } from "../../src/tools/memory.js";
import { getContext } from "../../src/tools/context.js";

describe("getContext", () => {
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

  it("returns memories from all spaces the repo belongs to", () => {
    createSpace(db, "space-a", "Space A");
    createSpace(db, "space-b", "Space B");
    addRepoToSpace(db, "space-a", "/my/repo");
    addRepoToSpace(db, "space-b", "/my/repo");

    writeMemory(db, {
      space: "space-a",
      category: "convention",
      title: "Convention from A",
      content: "Use tabs",
      source_repo: "/my/repo",
    });

    writeMemory(db, {
      space: "space-b",
      category: "context",
      title: "Context from B",
      content: "Backend uses Python",
      source_repo: "/other/repo",
    });

    const context = getContext(db, "/my/repo");
    expect(context.spaces).toHaveLength(2);
    expect(context.memories).toHaveLength(2);
  });

  it("returns empty when repo has no spaces", () => {
    const context = getContext(db, "/unknown/repo");
    expect(context.spaces).toHaveLength(0);
    expect(context.memories).toHaveLength(0);
  });

  it("does not return memories from unrelated spaces", () => {
    createSpace(db, "space-a", "Space A");
    createSpace(db, "space-b", "Space B");
    addRepoToSpace(db, "space-a", "/my/repo");

    writeMemory(db, {
      space: "space-b",
      category: "context",
      title: "Should not appear",
      content: "This is in space-b only",
      source_repo: "/other",
    });

    const context = getContext(db, "/my/repo");
    expect(context.memories).toHaveLength(0);
  });
});

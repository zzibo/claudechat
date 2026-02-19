import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../src/db/schema.js";
import { generateHandoff, receiveHandoff } from "../../src/tools/handoff.js";

describe("Handoff Tools", () => {
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

  describe("generateHandoff", () => {
    it("creates a handoff document", () => {
      const handoff = generateHandoff(db, {
        repo_path: "/my/repo",
        summary: "Worked on auth refactor",
        completed: ["Migrated JWT to sessions"],
        in_progress: ["Logout endpoint"],
        next_steps: ["Add session expiry job"],
      });

      expect(handoff.id).toBeDefined();
      expect(handoff.summary).toBe("Worked on auth refactor");
      expect(handoff.is_active).toBe(1);
    });

    it("deactivates previous handoffs for the same repo", () => {
      generateHandoff(db, {
        repo_path: "/my/repo",
        summary: "First session",
        completed: [],
        in_progress: [],
        next_steps: [],
      });

      generateHandoff(db, {
        repo_path: "/my/repo",
        summary: "Second session",
        completed: [],
        in_progress: [],
        next_steps: [],
      });

      const allHandoffs = db
        .prepare("SELECT * FROM handoffs WHERE repo_path = ?")
        .all("/my/repo") as { is_active: number }[];

      const active = allHandoffs.filter((h) => h.is_active === 1);
      expect(active).toHaveLength(1);
    });
  });

  describe("receiveHandoff", () => {
    it("returns the latest active handoff", () => {
      generateHandoff(db, {
        repo_path: "/my/repo",
        summary: "Latest session",
        completed: ["Did something"],
        in_progress: ["Doing something"],
        next_steps: ["Will do something"],
        pending_decisions: ["Session TTL: 24h vs 7d"],
        context_notes: "Check src/session/store.ts",
      });

      const handoff = receiveHandoff(db, "/my/repo");
      expect(handoff).not.toBeNull();
      expect(handoff!.summary).toBe("Latest session");
      expect(JSON.parse(handoff!.completed)).toContain("Did something");
    });

    it("returns null when no handoff exists", () => {
      const handoff = receiveHandoff(db, "/unknown/repo");
      expect(handoff).toBeNull();
    });
  });
});

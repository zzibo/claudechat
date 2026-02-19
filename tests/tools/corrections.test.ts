import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../src/db/schema.js";
import { createSpace } from "../../src/tools/spaces.js";
import {
  trackCorrection,
  getCorrections,
} from "../../src/tools/corrections.js";

describe("Correction Tools", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    createSpace(db, "test-space", "Test");
  });

  afterEach(() => {
    db.close();
  });

  describe("trackCorrection", () => {
    it("stores a correction", () => {
      const correction = trackCorrection(db, {
        context: "variable naming in TypeScript files",
        wrong_behavior: "Used snake_case for variable names",
        correct_behavior: "Use camelCase for all TypeScript variables",
        source_repo: "/my/repo",
        space_id: "test-space",
      });

      expect(correction.id).toBeDefined();
      expect(correction.wrong_behavior).toBe(
        "Used snake_case for variable names"
      );
    });
  });

  describe("getCorrections", () => {
    it("finds corrections by context search", () => {
      trackCorrection(db, {
        context: "variable naming in TypeScript files",
        wrong_behavior: "Used snake_case",
        correct_behavior: "Use camelCase",
        source_repo: "/repo",
      });

      trackCorrection(db, {
        context: "CSS class naming",
        wrong_behavior: "Used camelCase for CSS",
        correct_behavior: "Use BEM methodology",
        source_repo: "/repo",
      });

      const results = getCorrections(db, {
        context: "TypeScript variable naming",
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].wrong_behavior).toContain("snake_case");
    });

    it("returns all corrections when no filter provided", () => {
      trackCorrection(db, {
        context: "test context",
        wrong_behavior: "wrong",
        correct_behavior: "right",
        source_repo: "/repo",
      });

      const results = getCorrections(db, {});
      expect(results.length).toBeGreaterThan(0);
    });
  });
});

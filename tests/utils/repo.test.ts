import { describe, it, expect } from "vitest";
import { detectRepo } from "../../src/utils/repo.js";

describe("detectRepo", () => {
  it("returns a non-empty string for the current directory", () => {
    const repo = detectRepo();
    expect(typeof repo).toBe("string");
    expect(repo.length).toBeGreaterThan(0);
  });

  it("uses provided path when given", () => {
    const repo = detectRepo("/some/custom/path");
    expect(repo).toBe("/some/custom/path");
  });
});

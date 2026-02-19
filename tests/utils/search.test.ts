import { describe, it, expect } from "vitest";
import { sanitizeFtsQuery, buildFtsQuery } from "../../src/utils/search.js";

describe("sanitizeFtsQuery", () => {
  it("passes through simple words", () => {
    expect(sanitizeFtsQuery("hello world")).toBe("hello world");
  });

  it("removes FTS5 special characters", () => {
    expect(sanitizeFtsQuery('hello "world" (test)')).toBe("hello world test");
  });

  it("trims whitespace", () => {
    expect(sanitizeFtsQuery("  hello  ")).toBe("hello");
  });

  it("returns empty string for all-special input", () => {
    expect(sanitizeFtsQuery('"()*:')).toBe("");
  });
});

describe("buildFtsQuery", () => {
  it("joins words with OR for broad matching", () => {
    expect(buildFtsQuery("auth bug payments")).toBe("auth OR bug OR payments");
  });

  it("handles single word", () => {
    expect(buildFtsQuery("auth")).toBe("auth");
  });

  it("strips empty tokens", () => {
    expect(buildFtsQuery("auth  bug")).toBe("auth OR bug");
  });
});

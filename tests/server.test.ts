import { describe, it, expect } from "vitest";

describe("MCP Server", () => {
  it("module exports exist", async () => {
    const module = await import("../src/tools/memory.js");
    expect(module.writeMemory).toBeDefined();
    expect(module.recall).toBeDefined();
    expect(module.updateMemory).toBeDefined();
    expect(module.deleteMemory).toBeDefined();
  });

  it("all tool modules export correctly", async () => {
    const spaces = await import("../src/tools/spaces.js");
    expect(spaces.createSpace).toBeDefined();
    expect(spaces.listSpaces).toBeDefined();

    const handoff = await import("../src/tools/handoff.js");
    expect(handoff.generateHandoff).toBeDefined();
    expect(handoff.receiveHandoff).toBeDefined();

    const corrections = await import("../src/tools/corrections.js");
    expect(corrections.trackCorrection).toBeDefined();
    expect(corrections.getCorrections).toBeDefined();

    const context = await import("../src/tools/context.js");
    expect(context.getContext).toBeDefined();
  });
});

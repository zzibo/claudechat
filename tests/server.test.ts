import { describe, it, expect } from "vitest";

describe("MCP Server v3", () => {
  it("channel tool modules export correctly", async () => {
    const channels = await import("../src/tools/channels.js");
    expect(channels.createChannel).toBeDefined();
    expect(channels.listChannels).toBeDefined();
    expect(channels.connectRepo).toBeDefined();
    expect(channels.disconnectRepo).toBeDefined();
    expect(channels.syncChannel).toBeDefined();
  });

  it("messaging tool modules export correctly", async () => {
    const messaging = await import("../src/tools/messaging.js");
    expect(messaging.postMessage).toBeDefined();
    expect(messaging.checkMessages).toBeDefined();
    expect(messaging.getNewMessageNotifications).toBeDefined();
  });

  it("search tool modules export correctly", async () => {
    const search = await import("../src/tools/search.js");
    expect(search.searchChannel).toBeDefined();
    expect(search.pinMessage).toBeDefined();
  });

  it("briefing tool modules export correctly", async () => {
    const briefing = await import("../src/tools/briefing.js");
    expect(briefing.joinChannel).toBeDefined();
  });

  it("handoff tool modules export correctly", async () => {
    const handoff = await import("../src/tools/handoff.js");
    expect(handoff.postHandoff).toBeDefined();
  });

  it("compression modules export correctly", async () => {
    const compression = await import("../src/tools/compression.js");
    expect(compression.compressChannel).toBeDefined();
    expect(compression.extractActionLines).toBeDefined();
  });
});

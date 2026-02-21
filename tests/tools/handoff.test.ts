import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../src/db/schema.js";
import { createChannel, connectRepo } from "../../src/tools/channels.js";
import { postHandoff } from "../../src/tools/handoff.js";

describe("Handoff", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    createChannel(db, "test-ch", "test");
    connectRepo(db, "test-ch", "/repo/a");
  });

  afterEach(() => {
    db.close();
  });

  it("posts a handoff message to the channel", () => {
    const msg = postHandoff(db, {
      channel: "test-ch",
      summary: "Completed auth system",
      sender_repo: "/repo/a",
      next_steps: ["Implement token refresh on frontend"],
    });
    expect(msg.type).toBe("handoff");
    expect(msg.content).toContain("Completed auth system");
    expect(msg.content).toContain("token refresh");
  });

  it("handoff without next_steps", () => {
    const msg = postHandoff(db, {
      channel: "test-ch",
      summary: "Done for today",
      sender_repo: "/repo/a",
    });
    expect(msg.type).toBe("handoff");
    expect(msg.content).toContain("Done for today");
  });

  it("stores metadata with summary and next_steps", () => {
    const msg = postHandoff(db, {
      channel: "test-ch",
      summary: "Finished API",
      sender_repo: "/repo/a",
      next_steps: ["Write tests", "Deploy"],
    });
    const meta = JSON.parse(msg.metadata);
    expect(meta.summary).toBe("Finished API");
    expect(meta.next_steps).toEqual(["Write tests", "Deploy"]);
  });
});

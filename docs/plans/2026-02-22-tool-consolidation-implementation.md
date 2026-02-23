# Tool Consolidation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace 10 MCP tools with 5 consolidated tools that have prescriptive descriptions telling Claude when to use them.

**Architecture:** Rewrite `src/index.ts` tool registrations. Underlying business logic in `src/tools/*.ts` stays unchanged. Extract briefing formatting into a shared helper to avoid duplication. Add optional `channel` param to `syncChannel`.

**Tech Stack:** TypeScript, MCP SDK, Zod, better-sqlite3, Vitest

---

### Task 1: Add optional channel param to syncChannel

**Files:**
- Modify: `src/tools/channels.ts:72-88`
- Modify: `tests/tools/channels.test.ts`

**Step 1: Write the failing test**

Add to the `syncChannel` describe block in `tests/tools/channels.test.ts`:

```typescript
it("uses provided channel name instead of deriving from repo", () => {
  const name = syncChannel(db, "/Users/zibo/my-project", "shared-app");
  expect(name).toBe("shared-app");
  const channels = listChannels(db);
  expect(channels[0].id).toBe("shared-app");
  expect(channels[0].repos).toContain("/Users/zibo/my-project");
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/zibo/claude-memory && npx vitest run tests/tools/channels.test.ts`
Expected: FAIL — syncChannel doesn't accept a third argument

**Step 3: Write minimal implementation**

In `src/tools/channels.ts`, update the `syncChannel` signature:

```typescript
export function syncChannel(
  db: Database.Database,
  repoPath: string,
  channelOverride?: string
): string {
  const channelName = channelOverride ?? repoPath.split("/").filter(Boolean).pop() ?? "default";

  db.prepare(
    "INSERT OR IGNORE INTO channels (id, description, context_budget) VALUES (?, ?, ?)"
  ).run(channelName, `Auto-created channel for ${channelName}`, 4000);

  db.prepare(
    "INSERT OR IGNORE INTO channel_repos (channel_id, repo_path) VALUES (?, ?)"
  ).run(channelName, repoPath);

  return channelName;
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/zibo/claude-memory && npx vitest run tests/tools/channels.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/tools/channels.ts tests/tools/channels.test.ts
git commit -m "feat: add optional channel override to syncChannel"
```

---

### Task 2: Extract briefing formatter helper

**Files:**
- Modify: `src/index.ts`

The briefing formatting logic is duplicated between `sync` and `join_channel`. Extract it into a helper function at the top of `index.ts` so the consolidated tools can reuse it.

**Step 1: Add helper function**

After the `notificationBanner` function in `src/index.ts`, add:

```typescript
import type { ChannelBriefing } from "./tools/briefing.js";

function formatBriefing(briefing: ChannelBriefing): string {
  let text = `# Channel: #${briefing.channel.id}\n`;
  text += `${briefing.channel.description}\n`;
  text += `${briefing.channel.member_count} repos connected. ${briefing.channel.total_messages} messages total.\n`;

  if (briefing.pinned.length > 0) {
    text += `\n📌 Pinned:\n`;
    text += briefing.pinned
      .map((p) => `- [${p.type.toUpperCase()}] ${p.content}`)
      .join("\n");
    text += "\n";
  }

  if (briefing.recent.length > 0) {
    text += `\nRecent:\n`;
    text += briefing.recent
      .map(
        (r) =>
          `- [${r.sender_repo.split("/").pop()} ${r.created_at}] ${r.content.slice(0, 200)}`
      )
      .join("\n");
    text += "\n";
  }

  if (briefing.summaries.length > 0) {
    text += `\nHistory:\n`;
    text += briefing.summaries.map((s) => s.content).join("\n\n");
    text += "\n";
  }

  return text;
}
```

**Step 2: Verify build compiles**

Run: `cd /Users/zibo/claude-memory && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "refactor: extract formatBriefing helper"
```

---

### Task 3: Rewrite index.ts with 5 consolidated tools

**Files:**
- Modify: `src/index.ts` (replace all tool registrations)

**Step 1: Replace all tool registrations**

Replace everything between `// --- Sync` and `// --- Start Server ---` with the 5 new tools:

```typescript
// --- sync ---

server.tool(
  "sync",
  "ALWAYS call this at the start of every session before doing any work. Auto-detects your repo, creates or joins the matching channel, and returns a context briefing with pinned decisions, recent messages, and history. Pass an optional channel name for cross-repo collaboration.",
  {
    channel: z
      .string()
      .optional()
      .describe("Channel name override for cross-repo collaboration (auto-derived from repo name if omitted)"),
  },
  async ({ channel }) => {
    const repo = detectRepo();
    const channelName = syncChannel(db, repo, channel);
    compressChannel(db, channelName);
    const briefing = joinChannel(db, channelName, repo);
    return {
      content: [{ type: "text", text: formatBriefing(briefing) }],
    };
  }
);

// --- post ---

server.tool(
  "post",
  "Post a message to your channel. Call this when you: complete a feature or milestone, make an architectural decision, encounter a blocker, or are ending a session (use type 'handoff' with next_steps). Other agents see your messages on their next interaction.",
  {
    channel: z.string().describe("Channel to post to"),
    content: z.string().describe("Message content"),
    type: z
      .enum(["chat", "decision", "convention", "correction", "task", "handoff"])
      .optional()
      .describe("Message type (default: chat)"),
    pin: z
      .boolean()
      .optional()
      .describe("Pin this message (always in briefings, never compressed)"),
    next_steps: z
      .array(z.string())
      .optional()
      .describe("Suggested next steps (only used with type 'handoff')"),
  },
  async ({ channel, content, type, pin, next_steps }) => {
    const repo = detectRepo();

    if (type === "handoff") {
      const msg = postHandoff(db, {
        channel,
        summary: content,
        sender_repo: repo,
        next_steps,
      });
      return {
        content: [
          {
            type: "text",
            text: `Handoff posted to #${channel}.\n\n${msg.content}`,
          },
        ],
      };
    }

    postMessage(db, { channel, content, sender_repo: repo, type, pin });
    compressChannel(db, channel);
    const banner = notificationBanner(repo);
    return {
      content: [
        { type: "text", text: `Message posted to #${channel}.${banner}` },
      ],
    };
  }
);

// --- check ---

server.tool(
  "check",
  "Check for new messages from other agents. Call this before starting work on a new task, when switching context, or periodically during long sessions. Shows unread messages across your connected channels.",
  {
    channel: z.string().optional().describe("Filter to a specific channel"),
    since: z
      .string()
      .optional()
      .describe("ISO timestamp to check from (default: last read)"),
  },
  async ({ channel, since }) => {
    const repo = detectRepo();
    if (channel) {
      const effectiveSince = since ?? "1970-01-01";
      const msgs = checkMessages(db, { channel, since: effectiveSince });
      if (msgs.length === 0) {
        return {
          content: [
            { type: "text", text: `No messages in #${channel}.` },
          ],
        };
      }
      const formatted = msgs
        .map(
          (m) =>
            `- [${m.sender_repo.split("/").pop()} ${m.created_at}] [${m.type}] ${m.content.slice(0, 200)}`
        )
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text: `${msgs.length} message(s) in #${channel}:\n${formatted}`,
          },
        ],
      };
    }

    const notifs = getNewMessageNotifications(db, repo);
    if (notifs.length === 0) {
      return { content: [{ type: "text", text: "No new messages." }] };
    }
    const formatted = notifs
      .map(
        (m) =>
          `- [${m.channel_id}] [${m.sender_repo.split("/").pop()}] ${m.content.slice(0, 200)}`
      )
      .join("\n");

    db.prepare(
      `UPDATE channel_repos SET last_read_at = datetime('now') WHERE repo_path = ?`
    ).run(repo);

    return {
      content: [
        {
          type: "text",
          text: `${notifs.length} new message(s):\n${formatted}`,
        },
      ],
    };
  }
);

// --- search ---

server.tool(
  "search",
  "Search past messages by keyword. Use when you need to recall a past decision, convention, or discussion. Set pin to a message ID to make it permanent in all future briefings.",
  {
    query: z.string().describe("Search query"),
    channel: z.string().optional().describe("Filter to specific channel"),
    type: z.string().optional().describe("Filter by message type"),
    pin: z
      .string()
      .optional()
      .describe("Message UUID to pin (instead of searching)"),
  },
  async ({ query, channel, type, pin }) => {
    const repo = detectRepo();

    if (pin) {
      const msg = pinMessage(db, pin);
      return {
        content: [
          {
            type: "text",
            text: `Message pinned: "${msg.content.slice(0, 100)}"`,
          },
        ],
      };
    }

    const results = searchChannel(db, { query, channel, type });
    const banner = notificationBanner(repo);

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No messages matching "${query}".${banner}`,
          },
        ],
      };
    }

    const formatted = results
      .map(
        (m, i) =>
          `${i + 1}. [#${m.channel_id}] [${m.type}] ${m.content.slice(0, 200)}\n   ID: ${m.id} | From: ${m.sender_repo} | ${m.created_at}`
      )
      .join("\n\n");

    return {
      content: [
        {
          type: "text",
          text: `Found ${results.length} message(s):\n\n${formatted}${banner}`,
        },
      ],
    };
  }
);

// --- manage ---

server.tool(
  "manage",
  "Admin operations: create a channel with custom settings, list all channels, connect or disconnect repos. You rarely need this — sync handles most setup automatically.",
  {
    action: z
      .enum(["create", "list", "connect", "disconnect"])
      .describe("Admin action to perform"),
    channel: z
      .string()
      .optional()
      .describe("Channel name (required for create/connect/disconnect)"),
    description: z
      .string()
      .optional()
      .describe("Channel description (for create)"),
    context_budget: z
      .number()
      .optional()
      .describe("Max tokens for context briefing (for create, default 4000)"),
    repo_path: z
      .string()
      .optional()
      .describe("Repo path (for connect/disconnect, auto-detected if omitted)"),
  },
  async ({ action, channel, description, context_budget, repo_path }) => {
    switch (action) {
      case "create": {
        if (!channel || !description) {
          return {
            content: [
              {
                type: "text",
                text: "Error: 'channel' and 'description' are required for create.",
              },
            ],
          };
        }
        const ch = createChannel(db, channel, description, context_budget);
        return {
          content: [
            {
              type: "text",
              text: `Channel #${ch.id} created.\n\n${JSON.stringify(ch, null, 2)}`,
            },
          ],
        };
      }
      case "list": {
        const channels = listChannels(db);
        if (channels.length === 0) {
          return {
            content: [
              { type: "text", text: "No channels exist yet. Use sync to auto-create one." },
            ],
          };
        }
        const formatted = channels
          .map(
            (c) =>
              `#${c.id}: ${c.description}\n  Repos: ${c.repos.length ? c.repos.join(", ") : "(none)"}`
          )
          .join("\n\n");
        return {
          content: [{ type: "text", text: `Channels:\n\n${formatted}` }],
        };
      }
      case "connect": {
        if (!channel) {
          return {
            content: [
              { type: "text", text: "Error: 'channel' is required for connect." },
            ],
          };
        }
        const repo = repo_path ?? detectRepo();
        connectRepo(db, channel, repo);
        return {
          content: [
            { type: "text", text: `Connected '${repo}' to #${channel}.` },
          ],
        };
      }
      case "disconnect": {
        if (!channel) {
          return {
            content: [
              { type: "text", text: "Error: 'channel' is required for disconnect." },
            ],
          };
        }
        const repo = repo_path ?? detectRepo();
        disconnectRepo(db, channel, repo);
        return {
          content: [
            { type: "text", text: `Disconnected '${repo}' from #${channel}.` },
          ],
        };
      }
    }
  }
);
```

**Step 2: Clean up imports**

The import for `ChannelBriefing` type was added in Task 2. Verify all imports are still needed — remove none (all functions are still used via the consolidated tools).

**Step 3: Bump version**

In `src/index.ts`, change `version: "0.2.0"` to `version: "0.3.0"`.

Also update `package.json` version to `"0.3.0"`.

**Step 4: Verify build compiles**

Run: `cd /Users/zibo/claude-memory && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/index.ts package.json
git commit -m "feat: consolidate 10 tools into 5 with prescriptive descriptions"
```

---

### Task 4: Update server tests

**Files:**
- Modify: `tests/server.test.ts`

**Step 1: Rewrite test file**

Replace the entire contents of `tests/server.test.ts`:

```typescript
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
```

**Step 2: Run all tests**

Run: `cd /Users/zibo/claude-memory && npx vitest run`
Expected: ALL PASS (68+ tests — 63 original + 5 new sync tests)

**Step 3: Commit**

```bash
git add tests/server.test.ts
git commit -m "test: update server tests for v0.3.0 tool surface"
```

---

### Task 5: Update README

**Files:**
- Modify: `README.md`

**Step 1: Update the tools section**

Replace the tools documentation in README.md to reflect the 5 new tools: `sync`, `post`, `check`, `search`, `manage`. Update the Quick Start to show `sync` as the first thing to call. Update the version to 0.3.0.

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README for v0.3.0 consolidated tools"
```

---

### Task 6: Build, push, verify

**Step 1: Build**

Run: `cd /Users/zibo/claude-memory && npm run build`
Expected: Compiles successfully

**Step 2: Run full test suite**

Run: `cd /Users/zibo/claude-memory && npx vitest run`
Expected: ALL PASS

**Step 3: Push**

```bash
git push origin master
```

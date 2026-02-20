# Smart Channels Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the v1 "memory database" architecture with Smart Channels — shared communication spaces with auto-managed context windows, message types, extractive compression, and near real-time notifications.

**Architecture:** MCP server backed by SQLite. Channels replace spaces, messages replace memories/handoffs/corrections. A compression engine keeps context within token budgets. Every tool response piggybacks new-message notifications.

**Tech Stack:** TypeScript, Node.js, @modelcontextprotocol/sdk, better-sqlite3, zod, vitest

**Migration strategy:** We rewrite the source files in-place. The v1 schema migration is handled in the new `schema.ts`. Tests are rewritten to match v2 behavior. This is a clean v2, not a patch on v1.

---

### Task 1: Update Schema for Smart Channels

**Files:**
- Modify: `src/db/schema.ts` (full rewrite)
- Modify: `tests/db/schema.test.ts` (full rewrite)

**Step 1: Write the failing test**

Replace `tests/db/schema.test.ts` with:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../src/db/schema.js";

describe("Schema v2", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
  });

  it("creates all required tables", () => {
    applySchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);

    expect(tables).toContain("schema_version");
    expect(tables).toContain("channels");
    expect(tables).toContain("channel_repos");
    expect(tables).toContain("messages");
    expect(tables).toContain("summaries");
  });

  it("creates FTS5 virtual table for messages", () => {
    applySchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);

    expect(tables).toContain("messages_fts");
  });

  it("is idempotent", () => {
    applySchema(db);
    expect(() => applySchema(db)).not.toThrow();
  });

  it("sets schema version to 2", () => {
    applySchema(db);
    const row = db.prepare("SELECT version FROM schema_version").get() as any;
    expect(row.version).toBe(2);
  });

  it("channels table has context_budget column", () => {
    applySchema(db);
    db.prepare("INSERT INTO channels (id, description) VALUES ('test', 'test channel')").run();
    const row = db.prepare("SELECT context_budget FROM channels WHERE id = 'test'").get() as any;
    expect(row.context_budget).toBe(4000);
  });

  it("channel_repos table has last_read_at column", () => {
    applySchema(db);
    db.prepare("INSERT INTO channels (id, description) VALUES ('test', 'test')").run();
    db.prepare("INSERT INTO channel_repos (channel_id, repo_path) VALUES ('test', '/foo')").run();
    const row = db.prepare("SELECT last_read_at FROM channel_repos WHERE channel_id = 'test'").get() as any;
    expect(row.last_read_at).toBeDefined();
  });

  it("messages table enforces type check constraint", () => {
    applySchema(db);
    db.prepare("INSERT INTO channels (id, description) VALUES ('test', 'test')").run();
    expect(() => {
      db.prepare(
        "INSERT INTO messages (id, channel_id, type, sender_repo, content) VALUES ('m1', 'test', 'invalid', '/foo', 'hello')"
      ).run();
    }).toThrow();
  });

  it("FTS5 triggers sync on insert", () => {
    applySchema(db);
    db.prepare("INSERT INTO channels (id, description) VALUES ('test', 'test')").run();
    db.prepare(
      "INSERT INTO messages (id, channel_id, type, sender_repo, content) VALUES ('m1', 'test', 'chat', '/foo', 'hello world test')"
    ).run();
    const results = db
      .prepare("SELECT * FROM messages_fts WHERE messages_fts MATCH 'hello'")
      .all();
    expect(results.length).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/schema.test.ts`
Expected: FAIL — old schema creates different tables

**Step 3: Write the implementation**

Replace `src/db/schema.ts` with:

```typescript
import type Database from "better-sqlite3";

export function applySchema(db: Database.Database): void {
  const hasVersion = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    )
    .get();

  if (hasVersion) {
    return;
  }

  db.exec(`
    CREATE TABLE schema_version (
      version INTEGER NOT NULL
    );
    INSERT INTO schema_version (version) VALUES (2);

    CREATE TABLE channels (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      context_budget INTEGER NOT NULL DEFAULT 4000,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE channel_repos (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      repo_path TEXT NOT NULL,
      last_read_at TEXT NOT NULL DEFAULT (datetime('now')),
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (channel_id, repo_path)
    );

    CREATE INDEX idx_channel_repos_repo ON channel_repos(repo_path);

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('chat', 'decision', 'convention', 'correction', 'handoff', 'task')),
      sender_repo TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      is_pinned INTEGER NOT NULL DEFAULT 0,
      is_compressed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_messages_channel ON messages(channel_id);
    CREATE INDEX idx_messages_type ON messages(type);
    CREATE INDEX idx_messages_created ON messages(channel_id, created_at);
    CREATE INDEX idx_messages_uncompressed ON messages(channel_id, is_compressed, created_at);

    CREATE TABLE summaries (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_summaries_channel ON summaries(channel_id, period_start);

    CREATE VIRTUAL TABLE messages_fts USING fts5(
      content,
      metadata,
      content = 'messages',
      content_rowid = 'rowid',
      tokenize = 'porter unicode61'
    );

    CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content, metadata)
      VALUES (new.rowid, new.content, new.metadata);
    END;

    CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, metadata)
      VALUES ('delete', old.rowid, old.content, old.metadata);
    END;

    CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, metadata)
      VALUES ('delete', old.rowid, old.content, old.metadata);
      INSERT INTO messages_fts(rowid, content, metadata)
      VALUES (new.rowid, new.content, new.metadata);
    END;
  `);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/schema.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/db/schema.ts tests/db/schema.test.ts
git commit -m "feat: replace v1 schema with Smart Channels schema (v2)"
```

---

### Task 2: Channel Management Tools

**Files:**
- Modify: `src/tools/spaces.ts` → rename to `src/tools/channels.ts`
- Modify: `tests/tools/spaces.test.ts` → rename to `tests/tools/channels.test.ts`

**Step 1: Write the failing test**

Delete `tests/tools/spaces.test.ts`. Create `tests/tools/channels.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../src/db/schema.js";
import { createChannel, listChannels, connectRepo, disconnectRepo } from "../src/tools/channels.js";

describe("Channel Management", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  describe("createChannel", () => {
    it("creates a channel with default budget", () => {
      const ch = createChannel(db, "test-channel", "A test channel");
      expect(ch.id).toBe("test-channel");
      expect(ch.description).toBe("A test channel");
      expect(ch.context_budget).toBe(4000);
      expect(ch.repos).toEqual([]);
    });

    it("creates a channel with custom budget", () => {
      const ch = createChannel(db, "big", "Big channel", 8000);
      expect(ch.context_budget).toBe(8000);
    });

    it("throws on duplicate name", () => {
      createChannel(db, "dup", "first");
      expect(() => createChannel(db, "dup", "second")).toThrow();
    });
  });

  describe("listChannels", () => {
    it("returns empty array when no channels", () => {
      expect(listChannels(db)).toEqual([]);
    });

    it("returns channels with repo counts and last activity", () => {
      createChannel(db, "ch1", "Channel 1");
      connectRepo(db, "ch1", "/repo/a");
      const channels = listChannels(db);
      expect(channels.length).toBe(1);
      expect(channels[0].id).toBe("ch1");
      expect(channels[0].repos).toContain("/repo/a");
    });
  });

  describe("connectRepo", () => {
    it("connects a repo to a channel", () => {
      createChannel(db, "ch", "test");
      connectRepo(db, "ch", "/my/repo");
      const channels = listChannels(db);
      expect(channels[0].repos).toContain("/my/repo");
    });

    it("throws if channel does not exist", () => {
      expect(() => connectRepo(db, "nope", "/repo")).toThrow();
    });

    it("ignores duplicate connections", () => {
      createChannel(db, "ch", "test");
      connectRepo(db, "ch", "/repo");
      connectRepo(db, "ch", "/repo"); // no throw
      const channels = listChannels(db);
      expect(channels[0].repos.length).toBe(1);
    });
  });

  describe("disconnectRepo", () => {
    it("removes a repo from a channel", () => {
      createChannel(db, "ch", "test");
      connectRepo(db, "ch", "/repo");
      disconnectRepo(db, "ch", "/repo");
      const channels = listChannels(db);
      expect(channels[0].repos.length).toBe(0);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/channels.test.ts`
Expected: FAIL — `channels.js` module does not exist

**Step 3: Write the implementation**

Delete `src/tools/spaces.ts`. Create `src/tools/channels.ts`:

```typescript
import type Database from "better-sqlite3";

export interface Channel {
  id: string;
  description: string;
  context_budget: number;
  created_at: string;
  repos: string[];
}

export function createChannel(
  db: Database.Database,
  name: string,
  description: string,
  contextBudget?: number
): Channel {
  const budget = contextBudget ?? 4000;
  db.prepare(
    "INSERT INTO channels (id, description, context_budget) VALUES (?, ?, ?)"
  ).run(name, description, budget);

  const row = db
    .prepare("SELECT * FROM channels WHERE id = ?")
    .get(name) as any;

  return { ...row, repos: [] };
}

export function listChannels(db: Database.Database): Channel[] {
  const channels = db.prepare("SELECT * FROM channels ORDER BY created_at DESC").all() as any[];

  return channels.map((ch) => {
    const repos = db
      .prepare("SELECT repo_path FROM channel_repos WHERE channel_id = ? ORDER BY joined_at")
      .all(ch.id)
      .map((r: any) => r.repo_path);

    return { ...ch, repos };
  });
}

export function connectRepo(
  db: Database.Database,
  channelName: string,
  repoPath: string
): void {
  const channel = db.prepare("SELECT id FROM channels WHERE id = ?").get(channelName);
  if (!channel) {
    throw new Error(`Channel '${channelName}' does not exist`);
  }
  db.prepare(
    "INSERT OR IGNORE INTO channel_repos (channel_id, repo_path) VALUES (?, ?)"
  ).run(channelName, repoPath);
}

export function disconnectRepo(
  db: Database.Database,
  channelName: string,
  repoPath: string
): void {
  db.prepare(
    "DELETE FROM channel_repos WHERE channel_id = ? AND repo_path = ?"
  ).run(channelName, repoPath);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools/channels.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git rm src/tools/spaces.ts tests/tools/spaces.test.ts
git add src/tools/channels.ts tests/tools/channels.test.ts
git commit -m "feat: replace spaces with channel management tools"
```

---

### Task 3: Messaging Tools (post_message, check_messages)

**Files:**
- Create: `src/tools/messaging.ts`
- Create: `tests/tools/messaging.test.ts`
- Delete: `src/tools/memory.ts`, `src/tools/handoff.ts`, `src/tools/corrections.ts`, `src/tools/context.ts`
- Delete: `tests/tools/memory.test.ts`, `tests/tools/handoff.test.ts`, `tests/tools/corrections.test.ts`, `tests/tools/context.test.ts`

**Step 1: Write the failing test**

Create `tests/tools/messaging.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../src/db/schema.js";
import { createChannel, connectRepo } from "../src/tools/channels.js";
import {
  postMessage,
  checkMessages,
  getNewMessageNotifications,
} from "../src/tools/messaging.js";

describe("Messaging", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    createChannel(db, "test-ch", "test channel");
    connectRepo(db, "test-ch", "/repo/a");
  });

  describe("postMessage", () => {
    it("posts a chat message", () => {
      const msg = postMessage(db, {
        channel: "test-ch",
        content: "hello world",
        sender_repo: "/repo/a",
      });
      expect(msg.id).toBeDefined();
      expect(msg.type).toBe("chat");
      expect(msg.content).toBe("hello world");
      expect(msg.is_pinned).toBe(0);
    });

    it("posts a decision message", () => {
      const msg = postMessage(db, {
        channel: "test-ch",
        content: "Use JWT",
        sender_repo: "/repo/a",
        type: "decision",
      });
      expect(msg.type).toBe("decision");
    });

    it("posts a pinned message", () => {
      const msg = postMessage(db, {
        channel: "test-ch",
        content: "Important",
        sender_repo: "/repo/a",
        pin: true,
      });
      expect(msg.is_pinned).toBe(1);
    });

    it("auto-pins convention messages", () => {
      const msg = postMessage(db, {
        channel: "test-ch",
        content: "Use named exports",
        sender_repo: "/repo/a",
        type: "convention",
      });
      expect(msg.is_pinned).toBe(1);
    });

    it("stores metadata for correction messages", () => {
      const msg = postMessage(db, {
        channel: "test-ch",
        content: "Don't use var, use const",
        sender_repo: "/repo/a",
        type: "correction",
        metadata: { wrong: "var x = 1", correct: "const x = 1" },
      });
      const parsed = JSON.parse(msg.metadata);
      expect(parsed.wrong).toBe("var x = 1");
    });
  });

  describe("checkMessages", () => {
    it("returns messages since a given time", () => {
      postMessage(db, {
        channel: "test-ch",
        content: "msg1",
        sender_repo: "/repo/a",
      });
      const since = new Date(Date.now() - 60000).toISOString();
      const msgs = checkMessages(db, { channel: "test-ch", since });
      expect(msgs.length).toBe(1);
    });

    it("returns empty when no new messages", () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      const msgs = checkMessages(db, { channel: "test-ch", since: future });
      expect(msgs.length).toBe(0);
    });
  });

  describe("getNewMessageNotifications", () => {
    it("returns new messages since last read for a repo", () => {
      // Post a message, then check notifications
      postMessage(db, {
        channel: "test-ch",
        content: "new update",
        sender_repo: "/repo/b",
      });
      const notifs = getNewMessageNotifications(db, "/repo/a");
      expect(notifs.length).toBeGreaterThanOrEqual(1);
      expect(notifs[0].content).toBe("new update");
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/messaging.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/tools/messaging.ts`:

```typescript
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface Message {
  id: string;
  channel_id: string;
  type: string;
  sender_repo: string;
  content: string;
  metadata: string;
  is_pinned: number;
  is_compressed: number;
  created_at: string;
}

export interface PostMessageInput {
  channel: string;
  content: string;
  sender_repo: string;
  type?: "chat" | "decision" | "convention" | "correction" | "handoff" | "task";
  pin?: boolean;
  metadata?: Record<string, unknown>;
}

export interface CheckMessagesInput {
  channel?: string;
  since?: string;
}

const AUTO_PIN_TYPES = new Set(["convention"]);

export function postMessage(db: Database.Database, input: PostMessageInput): Message {
  const id = randomUUID();
  const type = input.type ?? "chat";
  const isPinned = input.pin || AUTO_PIN_TYPES.has(type) ? 1 : 0;
  const metadata = input.metadata ? JSON.stringify(input.metadata) : "{}";

  db.prepare(
    `INSERT INTO messages (id, channel_id, type, sender_repo, content, metadata, is_pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.channel, type, input.sender_repo, input.content, metadata, isPinned);

  // Update last_read_at for the sender (they've seen their own message)
  db.prepare(
    `UPDATE channel_repos SET last_read_at = datetime('now')
     WHERE channel_id = ? AND repo_path = ?`
  ).run(input.channel, input.sender_repo);

  return db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Message;
}

export function checkMessages(
  db: Database.Database,
  input: CheckMessagesInput
): Message[] {
  if (input.channel) {
    return db
      .prepare(
        `SELECT * FROM messages
         WHERE channel_id = ? AND created_at > ?
         ORDER BY created_at ASC`
      )
      .all(input.channel, input.since ?? "1970-01-01") as Message[];
  }

  return db
    .prepare(
      `SELECT * FROM messages WHERE created_at > ? ORDER BY created_at ASC`
    )
    .all(input.since ?? "1970-01-01") as Message[];
}

export function getNewMessageNotifications(
  db: Database.Database,
  repoPath: string
): Message[] {
  // Get all channels this repo is connected to, and find messages since last_read_at
  const repos = db
    .prepare("SELECT channel_id, last_read_at FROM channel_repos WHERE repo_path = ?")
    .all(repoPath) as { channel_id: string; last_read_at: string }[];

  const messages: Message[] = [];

  for (const repo of repos) {
    const newMsgs = db
      .prepare(
        `SELECT * FROM messages
         WHERE channel_id = ? AND created_at > ? AND sender_repo != ?
         ORDER BY created_at ASC`
      )
      .all(repo.channel_id, repo.last_read_at, repoPath) as Message[];

    messages.push(...newMsgs);
  }

  return messages;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools/messaging.test.ts`
Expected: ALL PASS

**Step 5: Clean up old tool files**

```bash
git rm src/tools/memory.ts src/tools/handoff.ts src/tools/corrections.ts src/tools/context.ts
git rm tests/tools/memory.test.ts tests/tools/handoff.test.ts tests/tools/corrections.test.ts tests/tools/context.test.ts
```

**Step 6: Commit**

```bash
git add src/tools/messaging.ts tests/tools/messaging.test.ts
git commit -m "feat: add messaging tools (post, check, notifications)"
```

---

### Task 4: Search & Pin Tools

**Files:**
- Create: `src/tools/search.ts`
- Create: `tests/tools/search.test.ts`

**Step 1: Write the failing test**

Create `tests/tools/search.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../src/db/schema.js";
import { createChannel } from "../src/tools/channels.js";
import { postMessage } from "../src/tools/messaging.js";
import { searchChannel, pinMessage } from "../src/tools/search.js";

describe("Search & Pin", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    createChannel(db, "test-ch", "test");
  });

  describe("searchChannel", () => {
    it("finds messages by content", () => {
      postMessage(db, { channel: "test-ch", content: "JWT authentication setup", sender_repo: "/repo" });
      postMessage(db, { channel: "test-ch", content: "React component styling", sender_repo: "/repo" });
      const results = searchChannel(db, { query: "authentication" });
      expect(results.length).toBe(1);
      expect(results[0].content).toContain("JWT");
    });

    it("filters by channel", () => {
      createChannel(db, "other", "other");
      postMessage(db, { channel: "test-ch", content: "hello world", sender_repo: "/repo" });
      postMessage(db, { channel: "other", content: "hello world", sender_repo: "/repo" });
      const results = searchChannel(db, { query: "hello", channel: "test-ch" });
      expect(results.length).toBe(1);
      expect(results[0].channel_id).toBe("test-ch");
    });

    it("filters by message type", () => {
      postMessage(db, { channel: "test-ch", content: "Use JWT", sender_repo: "/repo", type: "decision" });
      postMessage(db, { channel: "test-ch", content: "JWT token refresh", sender_repo: "/repo", type: "chat" });
      const results = searchChannel(db, { query: "JWT", type: "decision" });
      expect(results.length).toBe(1);
      expect(results[0].type).toBe("decision");
    });

    it("returns empty on no match", () => {
      postMessage(db, { channel: "test-ch", content: "hello", sender_repo: "/repo" });
      const results = searchChannel(db, { query: "nonexistent" });
      expect(results.length).toBe(0);
    });
  });

  describe("pinMessage", () => {
    it("pins a message", () => {
      const msg = postMessage(db, { channel: "test-ch", content: "important", sender_repo: "/repo" });
      expect(msg.is_pinned).toBe(0);
      const pinned = pinMessage(db, msg.id);
      expect(pinned.is_pinned).toBe(1);
    });

    it("throws if message not found", () => {
      expect(() => pinMessage(db, "nonexistent")).toThrow();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/search.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/tools/search.ts`:

```typescript
import type Database from "better-sqlite3";
import type { Message } from "./messaging.js";
import { buildFtsQuery } from "../utils/search.js";

export interface SearchInput {
  query: string;
  channel?: string;
  type?: string;
  limit?: number;
}

export function searchChannel(
  db: Database.Database,
  input: SearchInput
): Message[] {
  const ftsQuery = buildFtsQuery(input.query);
  if (!ftsQuery) return [];

  const limit = input.limit ?? 20;
  let sql = `
    SELECT m.* FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    WHERE messages_fts MATCH ?
  `;
  const params: unknown[] = [ftsQuery];

  if (input.channel) {
    sql += " AND m.channel_id = ?";
    params.push(input.channel);
  }

  if (input.type) {
    sql += " AND m.type = ?";
    params.push(input.type);
  }

  sql += " ORDER BY bm25(messages_fts) LIMIT ?";
  params.push(limit);

  return db.prepare(sql).all(...params) as Message[];
}

export function pinMessage(
  db: Database.Database,
  messageId: string
): Message {
  const msg = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as Message | undefined;
  if (!msg) {
    throw new Error(`Message '${messageId}' not found`);
  }

  db.prepare("UPDATE messages SET is_pinned = 1 WHERE id = ?").run(messageId);
  return db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as Message;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools/search.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/tools/search.ts tests/tools/search.test.ts
git commit -m "feat: add search and pin tools"
```

---

### Task 5: Join Channel & Context Briefing

**Files:**
- Create: `src/tools/briefing.ts`
- Create: `tests/tools/briefing.test.ts`

This is the most complex tool — it assembles the token-budgeted context briefing.

**Step 1: Write the failing test**

Create `tests/tools/briefing.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../src/db/schema.js";
import { createChannel, connectRepo } from "../src/tools/channels.js";
import { postMessage } from "../src/tools/messaging.js";
import { joinChannel } from "../src/tools/briefing.js";

describe("Join Channel & Briefing", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    createChannel(db, "test-ch", "A test channel for coordination");
    connectRepo(db, "test-ch", "/repo/a");
  });

  it("returns channel info", () => {
    const briefing = joinChannel(db, "test-ch", "/repo/a");
    expect(briefing.channel.id).toBe("test-ch");
    expect(briefing.channel.description).toBe("A test channel for coordination");
  });

  it("returns pinned messages", () => {
    postMessage(db, { channel: "test-ch", content: "Use JWT", sender_repo: "/repo/a", type: "decision", pin: true });
    postMessage(db, { channel: "test-ch", content: "just a chat", sender_repo: "/repo/a" });
    const briefing = joinChannel(db, "test-ch", "/repo/a");
    expect(briefing.pinned.length).toBe(1);
    expect(briefing.pinned[0].content).toBe("Use JWT");
  });

  it("returns recent messages", () => {
    postMessage(db, { channel: "test-ch", content: "msg1", sender_repo: "/repo/a" });
    postMessage(db, { channel: "test-ch", content: "msg2", sender_repo: "/repo/a" });
    const briefing = joinChannel(db, "test-ch", "/repo/a");
    expect(briefing.recent.length).toBe(2);
  });

  it("returns summaries if they exist", () => {
    // Insert a summary directly
    db.prepare(
      "INSERT INTO summaries (id, channel_id, content, message_count, period_start, period_end) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("s1", "test-ch", "Earlier: set up project", 5, "2026-02-17", "2026-02-17");
    const briefing = joinChannel(db, "test-ch", "/repo/a");
    expect(briefing.summaries.length).toBe(1);
    expect(briefing.summaries[0].content).toBe("Earlier: set up project");
  });

  it("updates last_read_at for the repo", () => {
    const before = db
      .prepare("SELECT last_read_at FROM channel_repos WHERE channel_id = ? AND repo_path = ?")
      .get("test-ch", "/repo/a") as any;

    joinChannel(db, "test-ch", "/repo/a");

    const after = db
      .prepare("SELECT last_read_at FROM channel_repos WHERE channel_id = ? AND repo_path = ?")
      .get("test-ch", "/repo/a") as any;

    expect(after.last_read_at).not.toBe(before.last_read_at);
  });

  it("throws if channel does not exist", () => {
    expect(() => joinChannel(db, "nonexistent", "/repo/a")).toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/briefing.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/tools/briefing.ts`:

```typescript
import type Database from "better-sqlite3";
import type { Message } from "./messaging.js";

export interface Summary {
  id: string;
  channel_id: string;
  content: string;
  message_count: number;
  period_start: string;
  period_end: string;
  created_at: string;
}

export interface ChannelBriefing {
  channel: { id: string; description: string; context_budget: number; member_count: number; total_messages: number };
  pinned: Message[];
  recent: Message[];
  summaries: Summary[];
}

export function joinChannel(
  db: Database.Database,
  channelName: string,
  repoPath: string
): ChannelBriefing {
  const channel = db.prepare("SELECT * FROM channels WHERE id = ?").get(channelName) as any;
  if (!channel) {
    throw new Error(`Channel '${channelName}' does not exist`);
  }

  const memberCount = (
    db.prepare("SELECT COUNT(*) as cnt FROM channel_repos WHERE channel_id = ?").get(channelName) as any
  ).cnt;

  const totalMessages = (
    db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE channel_id = ?").get(channelName) as any
  ).cnt;

  // Layer 2: Pinned messages (always included)
  const pinned = db
    .prepare(
      "SELECT * FROM messages WHERE channel_id = ? AND is_pinned = 1 ORDER BY created_at ASC"
    )
    .all(channelName) as Message[];

  // Layer 3: Recent uncompressed messages (newest first, limit based on budget)
  // Simple heuristic: ~4 tokens per word, ~10 words per message ≈ 40 tokens/msg
  // Reserve 50% of budget for recent messages after pins
  const budgetForRecent = Math.floor(channel.context_budget * 0.5);
  const estimatedMsgLimit = Math.max(5, Math.floor(budgetForRecent / 40));

  const recent = db
    .prepare(
      `SELECT * FROM messages
       WHERE channel_id = ? AND is_compressed = 0 AND is_pinned = 0
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(channelName, estimatedMsgLimit) as Message[];

  // Reverse to chronological order
  recent.reverse();

  // Layer 4: Summaries (oldest first)
  const summaries = db
    .prepare(
      "SELECT * FROM summaries WHERE channel_id = ? ORDER BY period_start ASC"
    )
    .all(channelName) as Summary[];

  // Update last_read_at for this repo
  db.prepare(
    "UPDATE channel_repos SET last_read_at = datetime('now') WHERE channel_id = ? AND repo_path = ?"
  ).run(channelName, repoPath);

  return {
    channel: {
      id: channel.id,
      description: channel.description,
      context_budget: channel.context_budget,
      member_count: memberCount,
      total_messages: totalMessages,
    },
    pinned,
    recent,
    summaries,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools/briefing.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/tools/briefing.ts tests/tools/briefing.test.ts
git commit -m "feat: add join_channel with context briefing assembly"
```

---

### Task 6: Handoff Tool

**Files:**
- Create: `src/tools/handoff.ts` (new implementation, different from v1)
- Create: `tests/tools/handoff.test.ts` (rewritten)

**Step 1: Write the failing test**

Create `tests/tools/handoff.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../src/db/schema.js";
import { createChannel, connectRepo } from "../src/tools/channels.js";
import { postHandoff } from "../src/tools/handoff.js";

describe("Handoff", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    createChannel(db, "test-ch", "test");
    connectRepo(db, "test-ch", "/repo/a");
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
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/handoff.test.ts`
Expected: FAIL — `postHandoff` not exported from module

**Step 3: Write the implementation**

Create `src/tools/handoff.ts`:

```typescript
import type Database from "better-sqlite3";
import type { Message } from "./messaging.js";
import { postMessage } from "./messaging.js";

export interface PostHandoffInput {
  channel: string;
  summary: string;
  sender_repo: string;
  next_steps?: string[];
}

export function postHandoff(
  db: Database.Database,
  input: PostHandoffInput
): Message {
  let content = `Session Summary: ${input.summary}`;

  if (input.next_steps && input.next_steps.length > 0) {
    content += `\n\nNext Steps:\n${input.next_steps.map((s) => `- ${s}`).join("\n")}`;
  }

  return postMessage(db, {
    channel: input.channel,
    content,
    sender_repo: input.sender_repo,
    type: "handoff",
    metadata: {
      summary: input.summary,
      next_steps: input.next_steps ?? [],
    },
  });
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools/handoff.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/tools/handoff.ts tests/tools/handoff.test.ts
git commit -m "feat: add handoff tool as message type in channel"
```

---

### Task 7: Compression Engine

**Files:**
- Create: `src/tools/compression.ts`
- Create: `tests/tools/compression.test.ts`

**Step 1: Write the failing test**

Create `tests/tools/compression.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../src/db/schema.js";
import { createChannel } from "../src/tools/channels.js";
import { compressChannel, extractActionLines } from "../src/tools/compression.js";

describe("Compression Engine", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    createChannel(db, "test-ch", "test");
  });

  describe("extractActionLines", () => {
    it("extracts verb-first lines", () => {
      const lines = extractActionLines([
        "Added auth middleware",
        "working on it",
        "Fixed token refresh bug",
        "just chatting",
        "Updated the API docs",
      ]);
      expect(lines).toContain("Added auth middleware");
      expect(lines).toContain("Fixed token refresh bug");
      expect(lines).toContain("Updated the API docs");
    });

    it("extracts lines with key patterns", () => {
      const lines = extractActionLines([
        "Auth system done",
        "Merged PR #42",
        "random message",
      ]);
      expect(lines).toContain("Auth system done");
      expect(lines).toContain("Merged PR #42");
    });
  });

  describe("compressChannel", () => {
    it("does nothing when below threshold", () => {
      // Insert 3 old messages (below 50 threshold)
      for (let i = 0; i < 3; i++) {
        db.prepare(
          `INSERT INTO messages (id, channel_id, type, sender_repo, content, created_at)
           VALUES (?, 'test-ch', 'chat', '/repo', ?, datetime('now', '-2 days'))`
        ).run(`m${i}`, `Added feature ${i}`);
      }
      const result = compressChannel(db, "test-ch");
      expect(result.compressed).toBe(0);
    });

    it("compresses old messages above threshold", () => {
      // Insert 55 old messages
      for (let i = 0; i < 55; i++) {
        db.prepare(
          `INSERT INTO messages (id, channel_id, type, sender_repo, content, created_at)
           VALUES (?, 'test-ch', 'chat', '/repo', ?, datetime('now', '-3 days'))`
        ).run(`m${i}`, `Added feature ${i}`);
      }
      const result = compressChannel(db, "test-ch");
      expect(result.compressed).toBeGreaterThan(0);

      // Check summaries were created
      const summaries = db.prepare("SELECT * FROM summaries WHERE channel_id = 'test-ch'").all();
      expect(summaries.length).toBeGreaterThan(0);

      // Check messages marked as compressed
      const compressed = db
        .prepare("SELECT COUNT(*) as cnt FROM messages WHERE channel_id = 'test-ch' AND is_compressed = 1")
        .get() as any;
      expect(compressed.cnt).toBeGreaterThan(0);
    });

    it("never compresses pinned messages", () => {
      for (let i = 0; i < 55; i++) {
        db.prepare(
          `INSERT INTO messages (id, channel_id, type, sender_repo, content, is_pinned, created_at)
           VALUES (?, 'test-ch', 'chat', '/repo', ?, ?, datetime('now', '-3 days'))`
        ).run(`m${i}`, `Message ${i}`, i === 0 ? 1 : 0);
      }
      compressChannel(db, "test-ch");
      const pinned = db
        .prepare("SELECT * FROM messages WHERE id = 'm0'")
        .get() as any;
      expect(pinned.is_compressed).toBe(0);
    });

    it("never compresses decision/convention/correction types", () => {
      for (let i = 0; i < 55; i++) {
        const type = i === 0 ? "decision" : "chat";
        db.prepare(
          `INSERT INTO messages (id, channel_id, type, sender_repo, content, created_at)
           VALUES (?, 'test-ch', ?, '/repo', ?, datetime('now', '-3 days'))`
        ).run(`m${i}`, type, `Message ${i}`);
      }
      compressChannel(db, "test-ch");
      const decision = db
        .prepare("SELECT * FROM messages WHERE id = 'm0'")
        .get() as any;
      expect(decision.is_compressed).toBe(0);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/compression.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/tools/compression.ts`:

```typescript
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

const COMPRESSION_THRESHOLD = 50;
const PROTECTED_TYPES = new Set(["decision", "convention", "correction"]);
const ACTION_VERBS = /^(Added|Fixed|Updated|Removed|Refactored|Created|Implemented|Deployed|Merged|Resolved|Configured|Migrated|Installed|Built|Set up|Completed)/i;
const KEY_PATTERNS = /\b(done|complete|merged|deployed|shipped|released|finished|resolved)\b/i;

export function extractActionLines(lines: string[]): string[] {
  return lines.filter(
    (line) => ACTION_VERBS.test(line.trim()) || KEY_PATTERNS.test(line)
  );
}

interface CompressResult {
  compressed: number;
  summariesCreated: number;
}

export function compressChannel(
  db: Database.Database,
  channelId: string
): CompressResult {
  // Count compressible messages older than 24h
  const compressible = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM messages
       WHERE channel_id = ?
         AND is_compressed = 0
         AND is_pinned = 0
         AND type IN ('chat', 'task', 'handoff')
         AND created_at < datetime('now', '-1 day')`
    )
    .get(channelId) as any;

  if (compressible.cnt < COMPRESSION_THRESHOLD) {
    return { compressed: 0, summariesCreated: 0 };
  }

  // Fetch compressible messages grouped by date
  const messages = db
    .prepare(
      `SELECT id, content, sender_repo, created_at, date(created_at) as msg_date
       FROM messages
       WHERE channel_id = ?
         AND is_compressed = 0
         AND is_pinned = 0
         AND type IN ('chat', 'task', 'handoff')
         AND created_at < datetime('now', '-1 day')
       ORDER BY created_at ASC`
    )
    .all(channelId) as any[];

  // Group by date
  const groups = new Map<string, typeof messages>();
  for (const msg of messages) {
    const date = msg.msg_date;
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date)!.push(msg);
  }

  let totalCompressed = 0;
  let summariesCreated = 0;

  for (const [date, msgs] of groups) {
    // Extract action lines from message contents
    const contentLines = msgs.map((m: any) => m.content);
    let actionLines = extractActionLines(contentLines);

    // If no action lines extracted, fall back to first sentence of each message
    if (actionLines.length === 0) {
      actionLines = contentLines.map((c: string) => {
        const firstSentence = c.split(/[.\n]/)[0].trim();
        return firstSentence.length > 100
          ? firstSentence.slice(0, 100) + "..."
          : firstSentence;
      });
    }

    // Deduplicate
    const unique = [...new Set(actionLines)];

    // Check if multiple senders
    const senders = new Set(msgs.map((m: any) => m.sender_repo));
    const multiSender = senders.size > 1;

    // Build summary
    let summaryLines: string[];
    if (multiSender) {
      // Group by sender
      const bySender = new Map<string, string[]>();
      for (const msg of msgs) {
        if (!bySender.has(msg.sender_repo)) bySender.set(msg.sender_repo, []);
        bySender.get(msg.sender_repo)!.push(msg.content);
      }
      summaryLines = [];
      for (const [sender, contents] of bySender) {
        const senderActions = extractActionLines(contents);
        const senderName = sender.split("/").pop() || sender;
        if (senderActions.length > 0) {
          summaryLines.push(`[${senderName}] ${senderActions.join(", ")}`);
        } else {
          summaryLines.push(`[${senderName}] ${contents.length} messages`);
        }
      }
    } else {
      summaryLines = unique.slice(0, 10).map((l) => `• ${l}`);
    }

    const summaryContent = `${date} (${msgs.length} messages):\n${summaryLines.join("\n")}`;

    // Insert summary
    db.prepare(
      `INSERT INTO summaries (id, channel_id, content, message_count, period_start, period_end)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      channelId,
      summaryContent,
      msgs.length,
      msgs[0].created_at,
      msgs[msgs.length - 1].created_at
    );
    summariesCreated++;

    // Mark messages as compressed
    const ids = msgs.map((m: any) => m.id);
    for (const id of ids) {
      db.prepare("UPDATE messages SET is_compressed = 1 WHERE id = ?").run(id);
    }
    totalCompressed += ids.length;
  }

  return { compressed: totalCompressed, summariesCreated };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools/compression.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/tools/compression.ts tests/tools/compression.test.ts
git commit -m "feat: add extractive compression engine for channel history"
```

---

### Task 8: Wire All Tools into MCP Server

**Files:**
- Modify: `src/index.ts` (full rewrite)
- Modify: `tests/server.test.ts` (rewrite to match new exports)

**Step 1: Write the failing test**

Replace `tests/server.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

describe("MCP Server v2", () => {
  it("channel tool modules export correctly", async () => {
    const channels = await import("../src/tools/channels.js");
    expect(channels.createChannel).toBeDefined();
    expect(channels.listChannels).toBeDefined();
    expect(channels.connectRepo).toBeDefined();
    expect(channels.disconnectRepo).toBeDefined();
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

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — old imports still reference v1 modules

**Step 3: Write the implementation**

Replace `src/index.ts` with the full v2 MCP server wiring all 10 tools. This file:
- Imports all v2 tool modules
- Registers 10 tools with zod schemas
- Includes notification piggybacking helper
- Runs compression lazily on join_channel and post_message
- Connects stdio transport

```typescript
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getConnection } from "./db/connection.js";
import { applySchema } from "./db/schema.js";
import { createChannel, listChannels, connectRepo, disconnectRepo } from "./tools/channels.js";
import { postMessage, checkMessages, getNewMessageNotifications } from "./tools/messaging.js";
import { searchChannel, pinMessage } from "./tools/search.js";
import { joinChannel } from "./tools/briefing.js";
import { postHandoff } from "./tools/handoff.js";
import { compressChannel } from "./tools/compression.js";
import { detectRepo } from "./utils/repo.js";

const db = getConnection();
applySchema(db);

const server = new McpServer({
  name: "claude-memory",
  version: "0.2.0",
});

// Helper: format notification banner
function notificationBanner(repoPath: string): string {
  const notifs = getNewMessageNotifications(db, repoPath);
  if (notifs.length === 0) return "";
  const lines = notifs.map(
    (n) => `- [${n.sender_repo.split("/").pop()}] ${n.content.slice(0, 120)}`
  );
  return `\n\n📬 ${notifs.length} new message(s):\n${lines.join("\n")}`;
}

// --- Channel Management ---

server.tool(
  "create_channel",
  "Create a new shared channel for agent communication",
  {
    name: z.string().describe("Unique channel name (e.g., 'fullstack-app')"),
    description: z.string().describe("What this channel coordinates"),
    context_budget: z.number().optional().describe("Max tokens for context briefing (default 4000)"),
  },
  async ({ name, description, context_budget }) => {
    const ch = createChannel(db, name, description, context_budget);
    return {
      content: [{ type: "text", text: `Channel #${ch.id} created.\n\n${JSON.stringify(ch, null, 2)}` }],
    };
  }
);

server.tool(
  "list_channels",
  "List all available channels with member count and activity",
  {},
  async () => {
    const channels = listChannels(db);
    if (channels.length === 0) {
      return {
        content: [{ type: "text", text: "No channels exist yet. Use create_channel to create one." }],
      };
    }
    const formatted = channels
      .map((c) => `#${c.id}: ${c.description}\n  Repos: ${c.repos.length ? c.repos.join(", ") : "(none)"}`)
      .join("\n\n");
    return {
      content: [{ type: "text", text: `Channels:\n\n${formatted}` }],
    };
  }
);

server.tool(
  "connect_repo",
  "Connect this repo to a channel so it can send and receive messages",
  {
    channel: z.string().describe("Channel name to connect to"),
    repo_path: z.string().optional().describe("Repo path (auto-detected if omitted)"),
  },
  async ({ channel, repo_path }) => {
    const repo = repo_path ?? detectRepo();
    connectRepo(db, channel, repo);
    return {
      content: [{ type: "text", text: `Connected '${repo}' to #${channel}.` }],
    };
  }
);

// --- Messaging ---

server.tool(
  "join_channel",
  "Join a channel and receive a context briefing. Use at session start to get full context.",
  {
    channel: z.string().describe("Channel name to join"),
  },
  async ({ channel }) => {
    const repo = detectRepo();
    // Run compression before assembling briefing
    compressChannel(db, channel);
    const briefing = joinChannel(db, channel, repo);

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
        .map((r) => `- [${r.sender_repo.split("/").pop()} ${r.created_at}] ${r.content.slice(0, 200)}`)
        .join("\n");
      text += "\n";
    }

    if (briefing.summaries.length > 0) {
      text += `\nHistory:\n`;
      text += briefing.summaries.map((s) => s.content).join("\n\n");
      text += "\n";
    }

    return {
      content: [{ type: "text", text }],
    };
  }
);

server.tool(
  "post_message",
  "Post a message to a channel. Other agents will see it on their next interaction.",
  {
    channel: z.string().describe("Channel to post to"),
    content: z.string().describe("Message content"),
    type: z.enum(["chat", "decision", "convention", "correction", "task"]).optional().describe("Message type (default: chat)"),
    pin: z.boolean().optional().describe("Pin this message (always in briefings, never compressed)"),
  },
  async ({ channel, content, type, pin }) => {
    const repo = detectRepo();
    const msg = postMessage(db, { channel, content, sender_repo: repo, type, pin });
    // Run compression lazily
    compressChannel(db, channel);
    const banner = notificationBanner(repo);
    return {
      content: [{ type: "text", text: `Message posted to #${channel}.${banner}` }],
    };
  }
);

server.tool(
  "check_messages",
  "Check for new messages across your connected channels",
  {
    channel: z.string().optional().describe("Filter to a specific channel"),
    since: z.string().optional().describe("ISO timestamp to check from (default: last read)"),
  },
  async ({ channel, since }) => {
    const repo = detectRepo();
    if (channel && since) {
      const msgs = checkMessages(db, { channel, since });
      if (msgs.length === 0) {
        return { content: [{ type: "text", text: `No new messages in #${channel}.` }] };
      }
      const formatted = msgs
        .map((m) => `- [${m.sender_repo.split("/").pop()} ${m.created_at}] [${m.type}] ${m.content.slice(0, 200)}`)
        .join("\n");
      return { content: [{ type: "text", text: `${msgs.length} message(s) in #${channel}:\n${formatted}` }] };
    }

    // Default: get notifications across all channels
    const notifs = getNewMessageNotifications(db, repo);
    if (notifs.length === 0) {
      return { content: [{ type: "text", text: "No new messages." }] };
    }
    const formatted = notifs
      .map((m) => `- [${m.channel_id}] [${m.sender_repo.split("/").pop()}] ${m.content.slice(0, 200)}`)
      .join("\n");

    // Update last_read_at for all connected channels
    db.prepare(
      `UPDATE channel_repos SET last_read_at = datetime('now') WHERE repo_path = ?`
    ).run(repo);

    return { content: [{ type: "text", text: `${notifs.length} new message(s):\n${formatted}` }] };
  }
);

// --- Search & Management ---

server.tool(
  "search_channel",
  "Search messages across channels using natural language",
  {
    query: z.string().describe("Search query"),
    channel: z.string().optional().describe("Filter to specific channel"),
    type: z.string().optional().describe("Filter by message type"),
  },
  async ({ query, channel, type }) => {
    const repo = detectRepo();
    const results = searchChannel(db, { query, channel, type });
    const banner = notificationBanner(repo);

    if (results.length === 0) {
      return { content: [{ type: "text", text: `No messages matching "${query}".${banner}` }] };
    }

    const formatted = results
      .map(
        (m, i) =>
          `${i + 1}. [#${m.channel_id}] [${m.type}] ${m.content.slice(0, 200)}\n   From: ${m.sender_repo} | ${m.created_at}`
      )
      .join("\n\n");

    return {
      content: [{ type: "text", text: `Found ${results.length} message(s):\n\n${formatted}${banner}` }],
    };
  }
);

server.tool(
  "pin_message",
  "Pin a message so it's always included in context briefings",
  {
    message_id: z.string().describe("UUID of the message to pin"),
  },
  async ({ message_id }) => {
    const msg = pinMessage(db, message_id);
    return {
      content: [{ type: "text", text: `Message pinned: "${msg.content.slice(0, 100)}"` }],
    };
  }
);

server.tool(
  "disconnect_repo",
  "Remove a repo from a channel",
  {
    channel: z.string().describe("Channel name"),
    repo_path: z.string().optional().describe("Repo path (auto-detected if omitted)"),
  },
  async ({ channel, repo_path }) => {
    const repo = repo_path ?? detectRepo();
    disconnectRepo(db, channel, repo);
    return {
      content: [{ type: "text", text: `Disconnected '${repo}' from #${channel}.` }],
    };
  }
);

// --- Session Continuity ---

server.tool(
  "handoff",
  "Post an end-of-session handoff so the next session can pick up where you left off",
  {
    channel: z.string().describe("Channel to post handoff to"),
    summary: z.string().describe("What happened this session"),
    next_steps: z.array(z.string()).optional().describe("Suggested next steps"),
  },
  async ({ channel, summary, next_steps }) => {
    const repo = detectRepo();
    const msg = postHandoff(db, { channel, summary, sender_repo: repo, next_steps });
    return {
      content: [{ type: "text", text: `Handoff posted to #${channel}.\n\n${msg.content}` }],
    };
  }
);

// --- Start Server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Claude Memory v2 (Smart Channels) running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
```

**Step 4: Run ALL tests**

Run: `npx vitest run`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/index.ts tests/server.test.ts
git commit -m "feat: wire all 10 Smart Channel tools into MCP server v2"
```

---

### Task 9: Update README

**Files:**
- Modify: `README.md`

**Step 1: Update README to reflect v2**

Replace the README with updated content reflecting Smart Channels:
- New tagline: "Slack for AI agents"
- Updated tool list (10 tools)
- New quick start showing channel workflow
- Updated architecture section

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README for Smart Channels v2"
```

---

### Task 10: Update server.test.ts and Run Full Suite

**Files:**
- Verify: `tests/server.test.ts` (already updated in Task 8)
- Run: Full test suite

**Step 1: Run complete test suite**

Run: `npx vitest run`
Expected: ALL PASS across all test files:
- `tests/db/schema.test.ts`
- `tests/tools/channels.test.ts`
- `tests/tools/messaging.test.ts`
- `tests/tools/search.test.ts`
- `tests/tools/briefing.test.ts`
- `tests/tools/handoff.test.ts`
- `tests/tools/compression.test.ts`
- `tests/server.test.ts`
- `tests/utils/search.test.ts`
- `tests/utils/repo.test.ts`

**Step 2: Build TypeScript**

Run: `npm run build`
Expected: Clean build, no errors

**Step 3: Verify MCP server starts**

Run: `node build/index.js` (should print to stderr and wait for stdio input)

**Step 4: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "chore: final cleanup for v2 release"
```

---

### Task 11: Push to GitHub

**Step 1: Ensure correct GitHub account**

Run: `gh auth status` and verify zzibo account is active.
If not: `gh auth switch --user zzibo`

**Step 2: Push**

Run: `git push origin master`

**Step 3: Verify**

Check https://github.com/zzibo/claude-memory for the updated code.

# Claude Memory — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an MCP server that gives Claude Code persistent, searchable, cross-repo memory with named spaces, session handoffs, and correction tracking.

**Architecture:** SQLite-backed MCP server using `@modelcontextprotocol/sdk` with stdio transport. FTS5 virtual tables for natural language search with BM25 ranking + recency/affinity boosts. 13 tools organized into 4 modules: memory, spaces, handoffs, corrections.

**Tech Stack:** TypeScript, Node.js, `@modelcontextprotocol/sdk`, `better-sqlite3`, `zod`, SQLite FTS5

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts`

**Step 1: Initialize package.json**

```bash
cd /Users/zibo/claude-memory
npm init -y
```

Then replace package.json contents:

```json
{
  "name": "claude-memory",
  "version": "0.1.0",
  "description": "MCP server that gives Claude Code persistent memory across sessions and repos",
  "type": "module",
  "bin": {
    "claude-memory": "./build/index.js"
  },
  "scripts": {
    "build": "tsc && chmod 755 build/index.js",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "inspector": "npx @modelcontextprotocol/inspector build/index.js"
  },
  "files": ["build"],
  "keywords": ["mcp", "claude", "memory", "ai", "claude-code"],
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/zzibo/claude-memory.git"
  }
}
```

**Step 2: Install dependencies**

```bash
cd /Users/zibo/claude-memory
npm install @modelcontextprotocol/sdk better-sqlite3 zod
npm install -D @types/better-sqlite3 @types/node typescript tsx vitest
```

**Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "build", "tests"]
}
```

**Step 4: Create minimal src/index.ts**

```typescript
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "claude-memory",
  version: "0.1.0",
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Claude Memory MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
```

**Step 5: Create .gitignore**

```
node_modules/
build/
*.db
*.db-wal
*.db-shm
.DS_Store
```

**Step 6: Build and verify**

```bash
cd /Users/zibo/claude-memory
npm run build
```

Expected: Compiles without errors, creates `build/index.js`.

**Step 7: Commit**

```bash
cd /Users/zibo/claude-memory
git add package.json tsconfig.json src/index.ts .gitignore package-lock.json
git commit -m "feat: scaffold project with MCP SDK, TypeScript, better-sqlite3"
```

---

### Task 2: Database Schema and Connection

**Files:**
- Create: `src/db/connection.ts`
- Create: `src/db/schema.ts`
- Create: `tests/db/schema.test.ts`

**Step 1: Write the failing test**

Create `tests/db/schema.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../src/db/schema.js";

describe("Database Schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
  });

  afterEach(() => {
    db.close();
  });

  it("creates all required tables", () => {
    applySchema(db);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("spaces");
    expect(tableNames).toContain("memories");
    expect(tableNames).toContain("memory_versions");
    expect(tableNames).toContain("space_repos");
    expect(tableNames).toContain("handoffs");
    expect(tableNames).toContain("corrections");
  });

  it("creates FTS5 virtual tables", () => {
    applySchema(db);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts%' ORDER BY name"
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("memories_fts");
    expect(tableNames).toContain("corrections_fts");
  });

  it("is idempotent — running twice does not error", () => {
    applySchema(db);
    expect(() => applySchema(db)).not.toThrow();
  });

  it("creates schema_version table with version 1", () => {
    applySchema(db);
    const row = db.prepare("SELECT version FROM schema_version").get() as {
      version: number;
    };
    expect(row.version).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd /Users/zibo/claude-memory
npx vitest run tests/db/schema.test.ts
```

Expected: FAIL — cannot find module `../../src/db/schema.js`

**Step 3: Create src/db/connection.ts**

```typescript
import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const MEMORY_DIR = join(homedir(), ".claude-memory");
const DB_PATH = join(MEMORY_DIR, "memory.db");

export function getConnection(dbPath?: string): Database.Database {
  const path = dbPath ?? DB_PATH;

  if (path !== ":memory:") {
    mkdirSync(join(path, ".."), { recursive: true });
  }

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}
```

**Step 4: Create src/db/schema.ts**

```typescript
import type Database from "better-sqlite3";

export function applySchema(db: Database.Database): void {
  // Check if schema already applied
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
    INSERT INTO schema_version (version) VALUES (1);

    -- Spaces
    CREATE TABLE spaces (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Memories
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      category TEXT NOT NULL CHECK (category IN ('convention', 'decision', 'context', 'preference', 'task')),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source_repo TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_memories_space ON memories(space_id);
    CREATE INDEX idx_memories_category ON memories(category);
    CREATE INDEX idx_memories_source_repo ON memories(source_repo);

    -- Memory versions
    CREATE TABLE memory_versions (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_memory_versions_memory ON memory_versions(memory_id);

    -- Space repos
    CREATE TABLE space_repos (
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      repo_path TEXT NOT NULL,
      PRIMARY KEY (space_id, repo_path)
    );

    CREATE INDEX idx_space_repos_repo ON space_repos(repo_path);

    -- Handoffs
    CREATE TABLE handoffs (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      space_id TEXT REFERENCES spaces(id) ON DELETE SET NULL,
      summary TEXT NOT NULL,
      completed TEXT NOT NULL DEFAULT '[]',
      in_progress TEXT NOT NULL DEFAULT '[]',
      next_steps TEXT NOT NULL DEFAULT '[]',
      pending_decisions TEXT NOT NULL DEFAULT '[]',
      context_notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX idx_handoffs_repo ON handoffs(repo_path);
    CREATE INDEX idx_handoffs_active ON handoffs(repo_path, is_active);

    -- Corrections
    CREATE TABLE corrections (
      id TEXT PRIMARY KEY,
      space_id TEXT REFERENCES spaces(id) ON DELETE SET NULL,
      context TEXT NOT NULL,
      wrong_behavior TEXT NOT NULL,
      correct_behavior TEXT NOT NULL,
      source_repo TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_corrections_space ON corrections(space_id);
    CREATE INDEX idx_corrections_repo ON corrections(source_repo);

    -- FTS5 for memories (external content)
    CREATE VIRTUAL TABLE memories_fts USING fts5(
      title,
      content,
      tags,
      content = 'memories',
      content_rowid = 'rowid',
      tokenize = 'porter unicode61'
    );

    -- FTS5 triggers for memories
    CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, title, content, tags)
      VALUES (new.rowid, new.title, new.content, new.tags);
    END;

    CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
      VALUES ('delete', old.rowid, old.title, old.content, old.tags);
    END;

    CREATE TRIGGER memories_fts_update AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
      VALUES ('delete', old.rowid, old.title, old.content, old.tags);
      INSERT INTO memories_fts(rowid, title, content, tags)
      VALUES (new.rowid, new.title, new.content, new.tags);
    END;

    -- FTS5 for corrections (external content)
    CREATE VIRTUAL TABLE corrections_fts USING fts5(
      context,
      wrong_behavior,
      correct_behavior,
      content = 'corrections',
      content_rowid = 'rowid',
      tokenize = 'porter unicode61'
    );

    -- FTS5 triggers for corrections
    CREATE TRIGGER corrections_fts_insert AFTER INSERT ON corrections BEGIN
      INSERT INTO corrections_fts(rowid, context, wrong_behavior, correct_behavior)
      VALUES (new.rowid, new.context, new.wrong_behavior, new.correct_behavior);
    END;

    CREATE TRIGGER corrections_fts_delete AFTER DELETE ON corrections BEGIN
      INSERT INTO corrections_fts(corrections_fts, rowid, context, wrong_behavior, correct_behavior)
      VALUES ('delete', old.rowid, old.context, old.wrong_behavior, old.correct_behavior);
    END;

    CREATE TRIGGER corrections_fts_update AFTER UPDATE ON corrections BEGIN
      INSERT INTO corrections_fts(corrections_fts, rowid, context, wrong_behavior, correct_behavior)
      VALUES ('delete', old.rowid, old.context, old.wrong_behavior, old.correct_behavior);
      INSERT INTO corrections_fts(rowid, context, wrong_behavior, correct_behavior)
      VALUES (new.rowid, new.context, new.wrong_behavior, new.correct_behavior);
    END;
  `);
}
```

**Step 5: Run test to verify it passes**

```bash
cd /Users/zibo/claude-memory
npx vitest run tests/db/schema.test.ts
```

Expected: All 4 tests PASS.

**Step 6: Commit**

```bash
cd /Users/zibo/claude-memory
git add src/db/ tests/db/
git commit -m "feat: add SQLite schema with FTS5 virtual tables and triggers"
```

---

### Task 3: Utility — Repo Detection and FTS5 Search

**Files:**
- Create: `src/utils/repo.ts`
- Create: `src/utils/search.ts`
- Create: `tests/utils/repo.test.ts`
- Create: `tests/utils/search.test.ts`

**Step 1: Write the failing test for repo detection**

Create `tests/utils/repo.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

```bash
cd /Users/zibo/claude-memory
npx vitest run tests/utils/repo.test.ts
```

Expected: FAIL — cannot find module

**Step 3: Implement src/utils/repo.ts**

```typescript
export function detectRepo(repoPath?: string): string {
  if (repoPath) {
    return repoPath;
  }
  return process.cwd();
}
```

**Step 4: Run test to verify it passes**

```bash
cd /Users/zibo/claude-memory
npx vitest run tests/utils/repo.test.ts
```

Expected: PASS

**Step 5: Write the failing test for search utilities**

Create `tests/utils/search.test.ts`:

```typescript
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
```

**Step 6: Run test to verify it fails**

```bash
cd /Users/zibo/claude-memory
npx vitest run tests/utils/search.test.ts
```

Expected: FAIL

**Step 7: Implement src/utils/search.ts**

```typescript
export function sanitizeFtsQuery(query: string): string {
  return query
    .replace(/[":*()\^{}~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildFtsQuery(query: string): string {
  const sanitized = sanitizeFtsQuery(query);
  const words = sanitized.split(" ").filter((w) => w.length > 0);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0];
  return words.join(" OR ");
}
```

**Step 8: Run tests to verify they pass**

```bash
cd /Users/zibo/claude-memory
npx vitest run tests/utils/
```

Expected: All tests PASS.

**Step 9: Commit**

```bash
cd /Users/zibo/claude-memory
git add src/utils/ tests/utils/
git commit -m "feat: add repo detection and FTS5 query utilities"
```

---

### Task 4: Space Management Tools

**Files:**
- Create: `src/tools/spaces.ts`
- Create: `tests/tools/spaces.test.ts`

**Step 1: Write the failing test**

Create `tests/tools/spaces.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../src/db/schema.js";
import {
  createSpace,
  listSpaces,
  addRepoToSpace,
  removeRepoFromSpace,
} from "../../src/tools/spaces.js";

describe("Space Management", () => {
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

  describe("createSpace", () => {
    it("creates a space and returns it", () => {
      const result = createSpace(db, "project-alpha", "My test project");
      expect(result.id).toBe("project-alpha");
      expect(result.description).toBe("My test project");
    });

    it("throws on duplicate space name", () => {
      createSpace(db, "project-alpha", "First");
      expect(() => createSpace(db, "project-alpha", "Second")).toThrow();
    });
  });

  describe("listSpaces", () => {
    it("returns empty array when no spaces exist", () => {
      expect(listSpaces(db)).toEqual([]);
    });

    it("returns spaces with their repos", () => {
      createSpace(db, "space-1", "Space one");
      addRepoToSpace(db, "space-1", "/path/to/repo-a");
      addRepoToSpace(db, "space-1", "/path/to/repo-b");

      const spaces = listSpaces(db);
      expect(spaces).toHaveLength(1);
      expect(spaces[0].id).toBe("space-1");
      expect(spaces[0].repos).toContain("/path/to/repo-a");
      expect(spaces[0].repos).toContain("/path/to/repo-b");
    });
  });

  describe("addRepoToSpace", () => {
    it("links a repo to a space", () => {
      createSpace(db, "space-1", "Space one");
      addRepoToSpace(db, "space-1", "/path/to/repo");

      const spaces = listSpaces(db);
      expect(spaces[0].repos).toContain("/path/to/repo");
    });

    it("throws if space does not exist", () => {
      expect(() =>
        addRepoToSpace(db, "nonexistent", "/path/to/repo")
      ).toThrow();
    });
  });

  describe("removeRepoFromSpace", () => {
    it("unlinks a repo from a space", () => {
      createSpace(db, "space-1", "Space one");
      addRepoToSpace(db, "space-1", "/path/to/repo");
      removeRepoFromSpace(db, "space-1", "/path/to/repo");

      const spaces = listSpaces(db);
      expect(spaces[0].repos).toHaveLength(0);
    });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd /Users/zibo/claude-memory
npx vitest run tests/tools/spaces.test.ts
```

Expected: FAIL — cannot find module

**Step 3: Implement src/tools/spaces.ts**

```typescript
import type Database from "better-sqlite3";

export interface Space {
  id: string;
  description: string;
  created_at: string;
  repos: string[];
}

export function createSpace(
  db: Database.Database,
  name: string,
  description: string
): Space {
  db.prepare("INSERT INTO spaces (id, description) VALUES (?, ?)").run(
    name,
    description
  );

  const row = db.prepare("SELECT * FROM spaces WHERE id = ?").get(name) as {
    id: string;
    description: string;
    created_at: string;
  };

  return { ...row, repos: [] };
}

export function listSpaces(db: Database.Database): Space[] {
  const spaces = db.prepare("SELECT * FROM spaces ORDER BY id").all() as {
    id: string;
    description: string;
    created_at: string;
  }[];

  return spaces.map((space) => {
    const repos = db
      .prepare("SELECT repo_path FROM space_repos WHERE space_id = ?")
      .all(space.id) as { repo_path: string }[];

    return {
      ...space,
      repos: repos.map((r) => r.repo_path),
    };
  });
}

export function addRepoToSpace(
  db: Database.Database,
  spaceName: string,
  repoPath: string
): void {
  // Verify space exists
  const space = db.prepare("SELECT id FROM spaces WHERE id = ?").get(spaceName);
  if (!space) {
    throw new Error(`Space '${spaceName}' does not exist`);
  }

  db.prepare(
    "INSERT OR IGNORE INTO space_repos (space_id, repo_path) VALUES (?, ?)"
  ).run(spaceName, repoPath);
}

export function removeRepoFromSpace(
  db: Database.Database,
  spaceName: string,
  repoPath: string
): void {
  db.prepare(
    "DELETE FROM space_repos WHERE space_id = ? AND repo_path = ?"
  ).run(spaceName, repoPath);
}
```

**Step 4: Run tests to verify they pass**

```bash
cd /Users/zibo/claude-memory
npx vitest run tests/tools/spaces.test.ts
```

Expected: All tests PASS.

**Step 5: Commit**

```bash
cd /Users/zibo/claude-memory
git add src/tools/spaces.ts tests/tools/spaces.test.ts
git commit -m "feat: add space management tools (create, list, add/remove repo)"
```

---

### Task 5: Core Memory Tools (write, recall, update, delete)

**Files:**
- Create: `src/tools/memory.ts`
- Create: `tests/tools/memory.test.ts`

**Step 1: Write the failing test**

Create `tests/tools/memory.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../src/db/schema.js";
import { createSpace } from "../../src/tools/spaces.js";
import {
  writeMemory,
  recall,
  updateMemory,
  deleteMemory,
} from "../../src/tools/memory.js";

describe("Memory Tools", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    createSpace(db, "test-space", "Test space");
  });

  afterEach(() => {
    db.close();
  });

  describe("writeMemory", () => {
    it("creates a memory and returns it", () => {
      const mem = writeMemory(db, {
        space: "test-space",
        category: "convention",
        title: "Use camelCase",
        content: "Always use camelCase for variable names",
        source_repo: "/path/to/repo",
      });

      expect(mem.id).toBeDefined();
      expect(mem.title).toBe("Use camelCase");
      expect(mem.space_id).toBe("test-space");
    });

    it("stores tags as comma-separated string", () => {
      const mem = writeMemory(db, {
        space: "test-space",
        category: "convention",
        title: "Test",
        content: "Content",
        source_repo: "/repo",
        tags: "typescript,naming",
      });

      expect(mem.tags).toBe("typescript,naming");
    });
  });

  describe("recall", () => {
    it("finds memories by keyword search", () => {
      writeMemory(db, {
        space: "test-space",
        category: "context",
        title: "Fixed JWT auth bug",
        content: "The JWT token was expiring too early due to clock skew",
        source_repo: "/payments",
      });

      writeMemory(db, {
        space: "test-space",
        category: "convention",
        title: "CSS naming convention",
        content: "Use BEM methodology for all CSS classes",
        source_repo: "/frontend",
      });

      const results = recall(db, { query: "JWT auth bug" });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toContain("JWT");
    });

    it("returns empty array for no matches", () => {
      const results = recall(db, { query: "nonexistent xyzzy" });
      expect(results).toEqual([]);
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        writeMemory(db, {
          space: "test-space",
          category: "context",
          title: `Memory ${i}`,
          content: `This is test memory number ${i} about search`,
          source_repo: "/repo",
        });
      }

      const results = recall(db, { query: "search", limit: 3 });
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it("filters by space", () => {
      createSpace(db, "other-space", "Other");
      writeMemory(db, {
        space: "test-space",
        category: "context",
        title: "Test space memory",
        content: "This is in test space about databases",
        source_repo: "/repo",
      });
      writeMemory(db, {
        space: "other-space",
        category: "context",
        title: "Other space memory",
        content: "This is in other space about databases",
        source_repo: "/repo",
      });

      const results = recall(db, { query: "databases", space: "test-space" });
      expect(results.every((r) => r.space_id === "test-space")).toBe(true);
    });
  });

  describe("updateMemory", () => {
    it("updates content and creates a version", () => {
      const mem = writeMemory(db, {
        space: "test-space",
        category: "convention",
        title: "Original title",
        content: "Original content",
        source_repo: "/repo",
      });

      const updated = updateMemory(db, mem.id, {
        title: "Updated title",
        content: "Updated content",
      });

      expect(updated.title).toBe("Updated title");
      expect(updated.content).toBe("Updated content");

      // Check version was created
      const versions = db
        .prepare("SELECT * FROM memory_versions WHERE memory_id = ?")
        .all(mem.id) as { title: string; content: string }[];
      expect(versions).toHaveLength(1);
      expect(versions[0].title).toBe("Original title");
      expect(versions[0].content).toBe("Original content");
    });
  });

  describe("deleteMemory", () => {
    it("removes a memory", () => {
      const mem = writeMemory(db, {
        space: "test-space",
        category: "context",
        title: "To be deleted",
        content: "Content",
        source_repo: "/repo",
      });

      deleteMemory(db, mem.id);

      const row = db
        .prepare("SELECT * FROM memories WHERE id = ?")
        .get(mem.id);
      expect(row).toBeUndefined();
    });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd /Users/zibo/claude-memory
npx vitest run tests/tools/memory.test.ts
```

Expected: FAIL

**Step 3: Implement src/tools/memory.ts**

```typescript
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { buildFtsQuery } from "../utils/search.js";

export interface Memory {
  id: string;
  space_id: string;
  category: string;
  title: string;
  content: string;
  source_repo: string;
  tags: string;
  created_at: string;
  updated_at: string;
}

export interface WriteMemoryInput {
  space: string;
  category: string;
  title: string;
  content: string;
  source_repo: string;
  tags?: string;
}

export interface RecallInput {
  query: string;
  space?: string;
  category?: string;
  tags?: string;
  limit?: number;
  current_repo?: string;
}

export interface UpdateMemoryInput {
  title?: string;
  content?: string;
  tags?: string;
}

export function writeMemory(
  db: Database.Database,
  input: WriteMemoryInput
): Memory {
  const id = randomUUID();
  const tags = input.tags ?? "";

  db.prepare(
    `INSERT INTO memories (id, space_id, category, title, content, source_repo, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.space, input.category, input.title, input.content, input.source_repo, tags);

  return db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Memory;
}

export function recall(
  db: Database.Database,
  input: RecallInput
): Memory[] {
  const ftsQuery = buildFtsQuery(input.query);
  if (!ftsQuery) return [];

  const limit = input.limit ?? 10;

  // Build the query with optional filters
  let sql = `
    SELECT
      memories.*,
      bm25(memories_fts, 10.0, 1.0, 5.0) as bm25_score,
      CASE
        WHEN memories.created_at >= datetime('now', '-7 days') THEN 2.0
        WHEN memories.created_at >= datetime('now', '-30 days') THEN 1.5
        ELSE 1.0
      END as recency_boost,
      CASE
        WHEN memories.source_repo = ? THEN 1.5
        ELSE 1.0
      END as affinity_boost
    FROM memories_fts
    JOIN memories ON memories.rowid = memories_fts.rowid
    WHERE memories_fts MATCH ?
  `;

  const params: (string | number)[] = [input.current_repo ?? "", ftsQuery];

  if (input.space) {
    sql += " AND memories.space_id = ?";
    params.push(input.space);
  }

  if (input.category) {
    sql += " AND memories.category = ?";
    params.push(input.category);
  }

  if (input.tags) {
    const tagList = input.tags.split(",").map((t) => t.trim());
    for (const tag of tagList) {
      sql += " AND memories.tags LIKE ?";
      params.push(`%${tag}%`);
    }
  }

  sql += `
    ORDER BY (bm25_score * recency_boost * affinity_boost)
    LIMIT ?
  `;
  params.push(limit);

  return db.prepare(sql).all(...params) as Memory[];
}

export function updateMemory(
  db: Database.Database,
  id: string,
  input: UpdateMemoryInput
): Memory {
  const current = db
    .prepare("SELECT * FROM memories WHERE id = ?")
    .get(id) as Memory;

  if (!current) {
    throw new Error(`Memory '${id}' not found`);
  }

  // Save version of current state
  db.prepare(
    `INSERT INTO memory_versions (id, memory_id, title, content, tags)
     VALUES (?, ?, ?, ?, ?)`
  ).run(randomUUID(), id, current.title, current.content, current.tags);

  // Apply updates
  const title = input.title ?? current.title;
  const content = input.content ?? current.content;
  const tags = input.tags ?? current.tags;

  db.prepare(
    `UPDATE memories SET title = ?, content = ?, tags = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(title, content, tags, id);

  return db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Memory;
}

export function deleteMemory(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM memories WHERE id = ?").run(id);
}
```

**Step 4: Run tests to verify they pass**

```bash
cd /Users/zibo/claude-memory
npx vitest run tests/tools/memory.test.ts
```

Expected: All tests PASS.

**Step 5: Commit**

```bash
cd /Users/zibo/claude-memory
git add src/tools/memory.ts tests/tools/memory.test.ts
git commit -m "feat: add core memory tools (write, recall, update, delete) with FTS5 search"
```

---

### Task 6: Context Tool (get_context)

**Files:**
- Create: `src/tools/context.ts`
- Create: `tests/tools/context.test.ts`

**Step 1: Write the failing test**

Create `tests/tools/context.test.ts`:

```typescript
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
    // space-b is NOT linked to /my/repo

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
```

**Step 2: Run test to verify it fails**

```bash
cd /Users/zibo/claude-memory
npx vitest run tests/tools/context.test.ts
```

Expected: FAIL

**Step 3: Implement src/tools/context.ts**

```typescript
import type Database from "better-sqlite3";
import type { Memory } from "./memory.js";

export interface ContextResult {
  repo_path: string;
  spaces: { id: string; description: string }[];
  memories: Memory[];
}

export function getContext(
  db: Database.Database,
  repoPath: string
): ContextResult {
  // Find all spaces this repo belongs to
  const spaceRows = db
    .prepare(
      `SELECT s.id, s.description
       FROM space_repos sr
       JOIN spaces s ON s.id = sr.space_id
       WHERE sr.repo_path = ?`
    )
    .all(repoPath) as { id: string; description: string }[];

  if (spaceRows.length === 0) {
    return { repo_path: repoPath, spaces: [], memories: [] };
  }

  // Get all memories from those spaces
  const placeholders = spaceRows.map(() => "?").join(", ");
  const spaceIds = spaceRows.map((s) => s.id);

  const memories = db
    .prepare(
      `SELECT * FROM memories
       WHERE space_id IN (${placeholders})
       ORDER BY updated_at DESC`
    )
    .all(...spaceIds) as Memory[];

  return {
    repo_path: repoPath,
    spaces: spaceRows,
    memories,
  };
}
```

**Step 4: Run tests to verify they pass**

```bash
cd /Users/zibo/claude-memory
npx vitest run tests/tools/context.test.ts
```

Expected: All tests PASS.

**Step 5: Commit**

```bash
cd /Users/zibo/claude-memory
git add src/tools/context.ts tests/tools/context.test.ts
git commit -m "feat: add get_context tool to load all memories for a repo"
```

---

### Task 7: Handoff Tools (generate_handoff, receive_handoff)

**Files:**
- Create: `src/tools/handoff.ts`
- Create: `tests/tools/handoff.test.ts`

**Step 1: Write the failing test**

Create `tests/tools/handoff.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

```bash
cd /Users/zibo/claude-memory
npx vitest run tests/tools/handoff.test.ts
```

Expected: FAIL

**Step 3: Implement src/tools/handoff.ts**

```typescript
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface Handoff {
  id: string;
  repo_path: string;
  space_id: string | null;
  summary: string;
  completed: string;
  in_progress: string;
  next_steps: string;
  pending_decisions: string;
  context_notes: string;
  created_at: string;
  is_active: number;
}

export interface GenerateHandoffInput {
  repo_path: string;
  space_id?: string;
  summary: string;
  completed: string[];
  in_progress: string[];
  next_steps: string[];
  pending_decisions?: string[];
  context_notes?: string;
}

export function generateHandoff(
  db: Database.Database,
  input: GenerateHandoffInput
): Handoff {
  const id = randomUUID();

  // Deactivate previous handoffs for this repo
  db.prepare(
    "UPDATE handoffs SET is_active = 0 WHERE repo_path = ? AND is_active = 1"
  ).run(input.repo_path);

  db.prepare(
    `INSERT INTO handoffs (id, repo_path, space_id, summary, completed, in_progress, next_steps, pending_decisions, context_notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.repo_path,
    input.space_id ?? null,
    input.summary,
    JSON.stringify(input.completed),
    JSON.stringify(input.in_progress),
    JSON.stringify(input.next_steps),
    JSON.stringify(input.pending_decisions ?? []),
    input.context_notes ?? ""
  );

  return db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id) as Handoff;
}

export function receiveHandoff(
  db: Database.Database,
  repoPath: string
): Handoff | null {
  const handoff = db
    .prepare(
      "SELECT * FROM handoffs WHERE repo_path = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1"
    )
    .get(repoPath) as Handoff | undefined;

  return handoff ?? null;
}
```

**Step 4: Run tests to verify they pass**

```bash
cd /Users/zibo/claude-memory
npx vitest run tests/tools/handoff.test.ts
```

Expected: All tests PASS.

**Step 5: Commit**

```bash
cd /Users/zibo/claude-memory
git add src/tools/handoff.ts tests/tools/handoff.test.ts
git commit -m "feat: add handoff tools for session continuity"
```

---

### Task 8: Correction Tools (track_correction, get_corrections)

**Files:**
- Create: `src/tools/corrections.ts`
- Create: `tests/tools/corrections.test.ts`

**Step 1: Write the failing test**

Create `tests/tools/corrections.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

```bash
cd /Users/zibo/claude-memory
npx vitest run tests/tools/corrections.test.ts
```

Expected: FAIL

**Step 3: Implement src/tools/corrections.ts**

```typescript
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { buildFtsQuery } from "../utils/search.js";

export interface Correction {
  id: string;
  space_id: string | null;
  context: string;
  wrong_behavior: string;
  correct_behavior: string;
  source_repo: string;
  tags: string;
  created_at: string;
}

export interface TrackCorrectionInput {
  context: string;
  wrong_behavior: string;
  correct_behavior: string;
  source_repo: string;
  space_id?: string;
  tags?: string;
}

export interface GetCorrectionsInput {
  context?: string;
  tags?: string;
  limit?: number;
}

export function trackCorrection(
  db: Database.Database,
  input: TrackCorrectionInput
): Correction {
  const id = randomUUID();

  db.prepare(
    `INSERT INTO corrections (id, space_id, context, wrong_behavior, correct_behavior, source_repo, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.space_id ?? null,
    input.context,
    input.wrong_behavior,
    input.correct_behavior,
    input.source_repo,
    input.tags ?? ""
  );

  return db
    .prepare("SELECT * FROM corrections WHERE id = ?")
    .get(id) as Correction;
}

export function getCorrections(
  db: Database.Database,
  input: GetCorrectionsInput
): Correction[] {
  const limit = input.limit ?? 10;

  if (input.context) {
    const ftsQuery = buildFtsQuery(input.context);
    if (!ftsQuery) return [];

    let sql = `
      SELECT corrections.*
      FROM corrections_fts
      JOIN corrections ON corrections.rowid = corrections_fts.rowid
      WHERE corrections_fts MATCH ?
    `;
    const params: (string | number)[] = [ftsQuery];

    if (input.tags) {
      const tagList = input.tags.split(",").map((t) => t.trim());
      for (const tag of tagList) {
        sql += " AND corrections.tags LIKE ?";
        params.push(`%${tag}%`);
      }
    }

    sql += " ORDER BY bm25(corrections_fts) LIMIT ?";
    params.push(limit);

    return db.prepare(sql).all(...params) as Correction[];
  }

  // No context search — return recent corrections
  let sql = "SELECT * FROM corrections";
  const params: (string | number)[] = [];

  if (input.tags) {
    const tagList = input.tags.split(",").map((t) => t.trim());
    const conditions = tagList.map(() => "tags LIKE ?");
    sql += " WHERE " + conditions.join(" AND ");
    params.push(...tagList.map((t) => `%${t}%`));
  }

  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);

  return db.prepare(sql).all(...params) as Correction[];
}
```

**Step 4: Run tests to verify they pass**

```bash
cd /Users/zibo/claude-memory
npx vitest run tests/tools/corrections.test.ts
```

Expected: All tests PASS.

**Step 5: Commit**

```bash
cd /Users/zibo/claude-memory
git add src/tools/corrections.ts tests/tools/corrections.test.ts
git commit -m "feat: add correction tracking tools with FTS5 search"
```

---

### Task 9: Wire All Tools into MCP Server

**Files:**
- Modify: `src/index.ts`

**Step 1: Write the failing test**

Create `tests/server.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

// Basic smoke test — verify the module can be imported
describe("MCP Server", () => {
  it("module exports exist", async () => {
    // This test verifies the server file can be parsed without errors
    // We can't easily test MCP servers in unit tests since they need stdio
    // but we can verify the module structure is valid
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
```

**Step 2: Run test to verify it passes (module imports should work)**

```bash
cd /Users/zibo/claude-memory
npx vitest run tests/server.test.ts
```

Expected: PASS (this verifies all modules are importable).

**Step 3: Rewrite src/index.ts with all tools registered**

```typescript
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getConnection } from "./db/connection.js";
import { applySchema } from "./db/schema.js";
import { writeMemory, recall, updateMemory, deleteMemory } from "./tools/memory.js";
import { getContext } from "./tools/context.js";
import { createSpace, listSpaces, addRepoToSpace, removeRepoFromSpace } from "./tools/spaces.js";
import { generateHandoff, receiveHandoff } from "./tools/handoff.js";
import { trackCorrection, getCorrections } from "./tools/corrections.js";
import { detectRepo } from "./utils/repo.js";

// Initialize database
const db = getConnection();
applySchema(db);

const server = new McpServer({
  name: "claude-memory",
  version: "0.1.0",
});

// --- Core Memory Tools ---

server.tool(
  "write_memory",
  "Store a new memory in a named space",
  {
    space: z.string().describe("Name of the memory space"),
    category: z.enum(["convention", "decision", "context", "preference", "task"]).describe("Memory category"),
    title: z.string().describe("Short summary of this memory"),
    content: z.string().describe("The full memory content"),
    tags: z.string().optional().describe("Comma-separated tags for filtering"),
  },
  async ({ space, category, title, content, tags }) => {
    const mem = writeMemory(db, {
      space,
      category,
      title,
      content,
      source_repo: detectRepo(),
      tags,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(mem, null, 2) }],
    };
  }
);

server.tool(
  "recall",
  "Search memories using natural language. Returns ranked results using FTS5 with recency and repo affinity boosts.",
  {
    query: z.string().describe("Natural language search query"),
    space: z.string().optional().describe("Filter to a specific space"),
    category: z.string().optional().describe("Filter by category"),
    tags: z.string().optional().describe("Filter by comma-separated tags"),
    limit: z.number().optional().describe("Max results to return (default 10)"),
  },
  async ({ query, space, category, tags, limit }) => {
    const results = recall(db, {
      query,
      space,
      category,
      tags,
      limit,
      current_repo: detectRepo(),
    });

    if (results.length === 0) {
      return {
        content: [{ type: "text", text: "No memories found matching that query." }],
      };
    }

    const formatted = results
      .map(
        (m, i) =>
          `${i + 1}. [${m.category}] ${m.title}\n   Space: ${m.space_id} | Repo: ${m.source_repo} | Tags: ${m.tags || "none"}\n   ${m.content.slice(0, 200)}${m.content.length > 200 ? "..." : ""}`
      )
      .join("\n\n");

    return {
      content: [{ type: "text", text: `Found ${results.length} memories:\n\n${formatted}` }],
    };
  }
);

server.tool(
  "update_memory",
  "Update an existing memory. Creates a version snapshot of the previous state.",
  {
    id: z.string().describe("UUID of the memory to update"),
    title: z.string().optional().describe("New title"),
    content: z.string().optional().describe("New content"),
    tags: z.string().optional().describe("New tags"),
  },
  async ({ id, title, content, tags }) => {
    const updated = updateMemory(db, id, { title, content, tags });
    return {
      content: [{ type: "text", text: JSON.stringify(updated, null, 2) }],
    };
  }
);

server.tool(
  "delete_memory",
  "Permanently delete a memory",
  {
    id: z.string().describe("UUID of the memory to delete"),
  },
  async ({ id }) => {
    deleteMemory(db, id);
    return {
      content: [{ type: "text", text: `Memory '${id}' deleted.` }],
    };
  }
);

server.tool(
  "get_context",
  "Load all memories from all spaces this repo belongs to. Use at the start of a session to get full context.",
  {
    repo_path: z.string().optional().describe("Repo path (auto-detected if omitted)"),
  },
  async ({ repo_path }) => {
    const result = getContext(db, repo_path ?? detectRepo());

    if (result.spaces.length === 0) {
      return {
        content: [{ type: "text", text: `No memory spaces found for repo '${result.repo_path}'. Use create_space and add_repo_to_space to set up.` }],
      };
    }

    const spaceSummary = result.spaces
      .map((s) => `- ${s.id}: ${s.description}`)
      .join("\n");

    const memSummary = result.memories
      .map(
        (m) =>
          `- [${m.category}] ${m.title} (${m.space_id})\n  ${m.content.slice(0, 150)}${m.content.length > 150 ? "..." : ""}`
      )
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text: `Context for ${result.repo_path}:\n\nSpaces:\n${spaceSummary}\n\nMemories (${result.memories.length}):\n${memSummary}`,
        },
      ],
    };
  }
);

// --- Handoff Tools ---

server.tool(
  "generate_handoff",
  "Create an end-of-session handoff document so the next session can pick up where you left off.",
  {
    summary: z.string().describe("What happened this session"),
    completed: z.array(z.string()).describe("List of completed items"),
    in_progress: z.array(z.string()).describe("List of in-progress items"),
    next_steps: z.array(z.string()).describe("List of next steps"),
    pending_decisions: z.array(z.string()).optional().describe("List of pending decisions"),
    context_notes: z.string().optional().describe("Freeform context for next session"),
  },
  async ({ summary, completed, in_progress, next_steps, pending_decisions, context_notes }) => {
    const handoff = generateHandoff(db, {
      repo_path: detectRepo(),
      summary,
      completed,
      in_progress,
      next_steps,
      pending_decisions,
      context_notes,
    });
    return {
      content: [{ type: "text", text: `Handoff saved. ID: ${handoff.id}\n\n${JSON.stringify(handoff, null, 2)}` }],
    };
  }
);

server.tool(
  "receive_handoff",
  "Load the latest handoff for this repo. Use at the start of a session to pick up where you left off.",
  {
    repo_path: z.string().optional().describe("Repo path (auto-detected if omitted)"),
  },
  async ({ repo_path }) => {
    const handoff = receiveHandoff(db, repo_path ?? detectRepo());

    if (!handoff) {
      return {
        content: [{ type: "text", text: "No previous handoff found for this repo." }],
      };
    }

    const completed = JSON.parse(handoff.completed) as string[];
    const inProgress = JSON.parse(handoff.in_progress) as string[];
    const nextSteps = JSON.parse(handoff.next_steps) as string[];
    const pending = JSON.parse(handoff.pending_decisions) as string[];

    let text = `Last session (${handoff.created_at}):\n`;
    text += `\nSummary: ${handoff.summary}\n`;
    if (completed.length) text += `\nCompleted:\n${completed.map((c) => `  - ${c}`).join("\n")}\n`;
    if (inProgress.length) text += `\nIn Progress:\n${inProgress.map((c) => `  - ${c}`).join("\n")}\n`;
    if (nextSteps.length) text += `\nNext Steps:\n${nextSteps.map((c) => `  - ${c}`).join("\n")}\n`;
    if (pending.length) text += `\nPending Decisions:\n${pending.map((c) => `  - ${c}`).join("\n")}\n`;
    if (handoff.context_notes) text += `\nContext Notes: ${handoff.context_notes}\n`;

    return {
      content: [{ type: "text", text }],
    };
  }
);

// --- Correction Tools ---

server.tool(
  "track_correction",
  "Log a correction when the developer corrects Claude's behavior. Claude should never repeat a corrected mistake.",
  {
    context: z.string().describe("What was happening when the correction was made"),
    wrong_behavior: z.string().describe("What Claude did wrong"),
    correct_behavior: z.string().describe("What Claude should do instead"),
    tags: z.string().optional().describe("Comma-separated tags"),
  },
  async ({ context, wrong_behavior, correct_behavior, tags }) => {
    const correction = trackCorrection(db, {
      context,
      wrong_behavior,
      correct_behavior,
      source_repo: detectRepo(),
      tags,
    });
    return {
      content: [{ type: "text", text: `Correction logged. ID: ${correction.id}\n\nI will not repeat this mistake.` }],
    };
  }
);

server.tool(
  "get_corrections",
  "Retrieve past corrections relevant to the current context. Use this to avoid repeating mistakes.",
  {
    context: z.string().optional().describe("What you're currently doing (used for FTS5 search)"),
    tags: z.string().optional().describe("Filter by comma-separated tags"),
  },
  async ({ context, tags }) => {
    const results = getCorrections(db, { context, tags });

    if (results.length === 0) {
      return {
        content: [{ type: "text", text: "No relevant corrections found." }],
      };
    }

    const formatted = results
      .map(
        (c, i) =>
          `${i + 1}. Context: ${c.context}\n   Wrong: ${c.wrong_behavior}\n   Correct: ${c.correct_behavior}`
      )
      .join("\n\n");

    return {
      content: [{ type: "text", text: `Found ${results.length} corrections:\n\n${formatted}` }],
    };
  }
);

// --- Space Management Tools ---

server.tool(
  "create_space",
  "Create a new named memory space for grouping related repos",
  {
    name: z.string().describe("Unique name for the space (e.g., 'project-alpha')"),
    description: z.string().describe("What this space is for"),
  },
  async ({ name, description }) => {
    const space = createSpace(db, name, description);
    return {
      content: [{ type: "text", text: `Space '${space.id}' created.\n\n${JSON.stringify(space, null, 2)}` }],
    };
  }
);

server.tool(
  "list_spaces",
  "List all memory spaces and their associated repos",
  {},
  async () => {
    const spaces = listSpaces(db);

    if (spaces.length === 0) {
      return {
        content: [{ type: "text", text: "No memory spaces exist yet. Use create_space to create one." }],
      };
    }

    const formatted = spaces
      .map(
        (s) =>
          `${s.id}: ${s.description}\n  Repos: ${s.repos.length ? s.repos.join(", ") : "(none)"}`
      )
      .join("\n\n");

    return {
      content: [{ type: "text", text: `Memory Spaces:\n\n${formatted}` }],
    };
  }
);

server.tool(
  "add_repo_to_space",
  "Link a repo to a memory space so it can access shared memories",
  {
    space_name: z.string().describe("Name of the space"),
    repo_path: z.string().describe("Absolute path to the repo"),
  },
  async ({ space_name, repo_path }) => {
    addRepoToSpace(db, space_name, repo_path);
    return {
      content: [{ type: "text", text: `Repo '${repo_path}' added to space '${space_name}'.` }],
    };
  }
);

server.tool(
  "remove_repo_from_space",
  "Unlink a repo from a memory space",
  {
    space_name: z.string().describe("Name of the space"),
    repo_path: z.string().describe("Absolute path to the repo"),
  },
  async ({ space_name, repo_path }) => {
    removeRepoFromSpace(db, space_name, repo_path);
    return {
      content: [{ type: "text", text: `Repo '${repo_path}' removed from space '${space_name}'.` }],
    };
  }
);

// --- Start Server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Claude Memory MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
```

**Step 4: Build and verify**

```bash
cd /Users/zibo/claude-memory
npm run build
```

Expected: Compiles without errors.

**Step 5: Run all tests**

```bash
cd /Users/zibo/claude-memory
npx vitest run
```

Expected: All tests PASS.

**Step 6: Commit**

```bash
cd /Users/zibo/claude-memory
git add src/index.ts tests/server.test.ts
git commit -m "feat: wire all 13 tools into MCP server with stdio transport"
```

---

### Task 10: Integration Test with MCP Inspector

**Files:**
- None new — manual verification

**Step 1: Build the server**

```bash
cd /Users/zibo/claude-memory
npm run build
```

**Step 2: Test with MCP Inspector**

```bash
cd /Users/zibo/claude-memory
npx @modelcontextprotocol/inspector build/index.js
```

This opens a web UI. Verify:
- All 13 tools are listed
- `create_space` works
- `write_memory` works
- `recall` returns results
- `generate_handoff` / `receive_handoff` work

**Step 3: Verify the database was created**

```bash
ls -la ~/.claude-memory/memory.db
```

Expected: File exists.

**Step 4: Commit if any fixes were needed**

```bash
cd /Users/zibo/claude-memory
git add -A
git commit -m "fix: address integration test issues" # only if needed
```

---

### Task 11: Add to Claude Code MCP Config

**Files:**
- Modify: `~/.claude/settings.json` (or the MCP config location for Claude Code)

**Step 1: Add claude-memory as an MCP server**

Find the correct Claude Code MCP config file. It may be at:
- `~/.claude/claude_desktop_config.json`
- Or configured via `claude mcp add`

Add:
```json
{
  "mcpServers": {
    "claude-memory": {
      "command": "node",
      "args": ["/Users/zibo/claude-memory/build/index.js"]
    }
  }
}
```

Or use the Claude Code CLI:
```bash
claude mcp add claude-memory node /Users/zibo/claude-memory/build/index.js
```

**Step 2: Restart Claude Code and verify tools appear**

Start a new Claude Code session and check that the 13 memory tools are available.

**Step 3: Smoke test**

Ask Claude to:
1. `create_space("test", "Testing")`
2. `write_memory` with some content
3. `recall` to search for it
4. `generate_handoff` at end
5. Close and reopen — `receive_handoff` should return the handoff

---

### Task 12: README and Final Polish

**Files:**
- Create: `README.md`
- Create: `LICENSE`

**Step 1: Write README.md**

Write a comprehensive README covering:
- What claude-memory is (one-liner + description)
- Quick start (install, configure, use)
- All 13 tools with brief descriptions
- Configuration options
- How memory spaces work
- Example workflows (session handoff, cross-repo sharing, corrections)
- Contributing guide
- License

**Step 2: Create MIT LICENSE**

Standard MIT license with copyright holder `zzibo`.

**Step 3: Commit and push**

```bash
cd /Users/zibo/claude-memory
git add README.md LICENSE
git commit -m "docs: add README and MIT license"
git push origin master
```

---

## Summary of Tasks

| Task | Description | Files | Depends On |
|------|-------------|-------|------------|
| 1 | Project scaffolding | package.json, tsconfig, index.ts | — |
| 2 | Database schema + FTS5 | db/schema.ts, db/connection.ts | 1 |
| 3 | Utilities (repo, search) | utils/repo.ts, utils/search.ts | 1 |
| 4 | Space management tools | tools/spaces.ts | 2 |
| 5 | Core memory tools | tools/memory.ts | 2, 3 |
| 6 | Context tool | tools/context.ts | 4, 5 |
| 7 | Handoff tools | tools/handoff.ts | 2 |
| 8 | Correction tools | tools/corrections.ts | 2, 3 |
| 9 | Wire into MCP server | index.ts | 4, 5, 6, 7, 8 |
| 10 | Integration test | — | 9 |
| 11 | Add to Claude Code | config | 10 |
| 12 | README + license | README.md, LICENSE | 9 |

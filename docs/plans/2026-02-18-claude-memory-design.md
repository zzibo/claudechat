# Claude Memory — Design Document

**Date:** 2026-02-18
**Status:** Approved
**Author:** zzibo

## Overview

Claude Memory is an MCP (Model Context Protocol) server that gives Claude Code persistent memory across terminal sessions and repositories. It solves the "cold start" problem where every new Claude session starts with zero context, and enables cross-repo knowledge sharing through named memory spaces.

## Problem

Every time you open a new Claude Code session:
- Claude has no memory of past conversations, decisions, or corrections
- You re-explain conventions, preferences, and project context
- Cross-repo context (e.g., frontend + backend) is completely lost
- Mistakes that were corrected get repeated

## Solution

An MCP server backed by SQLite that provides persistent, searchable, cross-repo memory with natural language recall and session continuity.

## Data Model

### Tables

**`spaces`** — Named memory spaces that group related repos

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | Unique space name (e.g., `project-alpha`) |
| description | TEXT | What this space is for |
| created_at | DATETIME | When the space was created |

**`memories`** — Individual memory entries

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| space_id | TEXT FK | Which space this belongs to |
| category | TEXT | `convention`, `decision`, `context`, `preference`, `task` |
| title | TEXT | Short summary |
| content | TEXT | The actual memory content |
| source_repo | TEXT | Which repo wrote this memory |
| tags | TEXT | Comma-separated tags for filtering |
| created_at | DATETIME | When it was written |
| updated_at | DATETIME | Last modified |

**`memories_fts`** — FTS5 virtual table indexing `title`, `content`, `tags` for natural language search.

**`memory_versions`** — Version history for memories

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| memory_id | TEXT FK | Which memory this is a version of |
| title | TEXT | Title at this version |
| content | TEXT | Content at this version |
| tags | TEXT | Tags at this version |
| created_at | DATETIME | When this version was created |

**`space_repos`** — Which repos belong to which spaces

| Column | Type | Description |
|--------|------|-------------|
| space_id | TEXT FK | The memory space |
| repo_path | TEXT | Absolute path to the repo |

**`handoffs`** — Session continuity documents

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| repo_path | TEXT | Which repo this handoff is for |
| space_id | TEXT FK | Associated space (nullable) |
| summary | TEXT | What happened this session |
| completed | TEXT | JSON array of completed items |
| in_progress | TEXT | JSON array of in-progress items |
| next_steps | TEXT | JSON array of next steps |
| pending_decisions | TEXT | JSON array of pending decisions |
| context_notes | TEXT | Freeform context for next session |
| created_at | DATETIME | When the handoff was generated |
| is_active | BOOLEAN | Only the latest handoff per repo is active |

**`corrections`** — Developer corrections to Claude's behavior

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| space_id | TEXT FK | Associated space (nullable) |
| context | TEXT | What was happening when the correction was made |
| wrong_behavior | TEXT | What Claude did wrong |
| correct_behavior | TEXT | What Claude should do instead |
| source_repo | TEXT | Where the correction was made |
| tags | TEXT | For filtering |
| created_at | DATETIME | When it was logged |

**`corrections_fts`** — FTS5 virtual table indexing `context`, `wrong_behavior`, `correct_behavior`.

## v1 MCP Tools (13 tools)

### Core Memory (5 tools)

**`write_memory(space, category, title, content, tags?)`**
Store a new memory. `source_repo` is auto-detected from the current working directory.

**`recall(query, space?, category?, tags?, limit?)`**
Natural language memory search. Uses FTS5 with BM25 ranking, recency boost (7 days = 2x, 30 days = 1.5x), and repo affinity boost (same repo/space = 1.5x). Returns top results ranked by combined score.

**`update_memory(id, content?, title?, tags?)`**
Update an existing memory. Automatically creates a version snapshot of the previous state.

**`delete_memory(id)`**
Remove a memory.

**`get_context(repo_path?)`**
Auto-detect which spaces this repo belongs to and return all relevant memories. If no `repo_path`, uses the current directory. This is the "give me everything I need" tool.

### Session Continuity (2 tools)

**`generate_handoff(summary, completed, in_progress, next_steps, pending_decisions?, context_notes?)`**
Store a structured end-of-session summary. Marks all previous handoffs for this repo as inactive. Auto-detects repo from current directory.

**`receive_handoff(repo_path?)`**
Retrieve the latest active handoff for the current repo. Returns null if no handoff exists. This is the "pick up where I left off" tool.

### Corrections (2 tools)

**`track_correction(context, wrong_behavior, correct_behavior, tags?)`**
Log a developer correction. Indexed for future FTS5 search.

**`get_corrections(context?, tags?)`**
Surface past corrections relevant to the current context. Matched via FTS5 on the context field + tag filtering.

### Space Management (4 tools)

**`create_space(name, description)`**
Create a new named memory space.

**`list_spaces()`**
List all available spaces with their associated repos.

**`add_repo_to_space(space_name, repo_path)`**
Associate a repo with a memory space. A repo can belong to multiple spaces.

**`remove_repo_from_space(space_name, repo_path)`**
Disassociate a repo from a space.

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **MCP framework:** `@modelcontextprotocol/sdk`
- **Database:** `better-sqlite3` (synchronous, fast, zero-config)
- **Search:** SQLite FTS5 virtual tables
- **Storage:** `~/.claude-memory/memory.db`
- **Config:** `~/.claude-memory/config.json`

## Project Structure

```
claude-memory/
├── src/
│   ├── index.ts              # MCP server entry point
│   ├── db/
│   │   ├── schema.ts         # SQLite table definitions + migrations
│   │   ├── connection.ts     # DB connection management
│   │   └── migrations/       # Versioned schema migrations
│   ├── tools/
│   │   ├── memory.ts         # write/recall/update/delete
│   │   ├── context.ts        # get_context
│   │   ├── handoff.ts        # generate_handoff/receive_handoff
│   │   ├── corrections.ts    # track_correction/get_corrections
│   │   └── spaces.ts         # create/list/add_repo/remove_repo
│   └── utils/
│       ├── search.ts         # FTS5 query building + ranking
│       └── repo.ts           # Auto-detect current repo path
├── tests/
├── package.json
├── tsconfig.json
└── README.md
```

## Installation

### Option 1: npx (recommended)
Add to Claude Code MCP config:
```json
{
  "mcpServers": {
    "claude-memory": {
      "command": "npx",
      "args": ["-y", "@claude-memory/mcp-server"]
    }
  }
}
```

### Option 2: Global install
```bash
npm install -g @claude-memory/mcp-server
```

## FTS5 Search Strategy

The `recall` tool uses SQLite FTS5 for natural language search with a custom ranking function:

```
final_score = bm25_score * recency_multiplier * affinity_multiplier
```

- **BM25 score:** Standard FTS5 relevance ranking
- **Recency multiplier:** 2.0 for memories < 7 days old, 1.5 for < 30 days, 1.0 otherwise
- **Affinity multiplier:** 1.5 if the memory is from the same repo or same space as the query context

## Deferred to v2

- `learn_pattern` / `apply_patterns` — Convention extraction
- `snapshot_decision` / `get_decisions` — Architectural decision records
- `send_message` / `get_messages` — Cross-repo messaging
- `claim_task` / `post_task` / `complete_task` — Multi-agent task board
- `reflect` — Self-assessment of memory quality
- `memory_timeline` — Chronological project narrative
- `memory_diff` — Cross-repo knowledge comparison
- `memory_stats` — Developer analytics
- `summarize_space` — Auto-compress old memories
- `export_space` / `import_memories` — Import/export

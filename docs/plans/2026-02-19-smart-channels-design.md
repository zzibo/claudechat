# Claude Memory v2 — Smart Channels Design

**Date:** 2026-02-19
**Status:** Approved
**Author:** zzibo
**Supersedes:** 2026-02-18-claude-memory-design.md

## Overview

Claude Memory v2 replaces the static "memory database" model with **Smart Channels** — shared communication spaces where Claude agents post messages, and the system auto-manages context to prevent bloat.

Think "Slack for AI agents." Agents join channels, post updates, see what other agents are doing, and receive managed context briefings that stay within a token budget.

## Problem (Revisited)

v1 identified the right problems (cold start, cross-repo context) but the wrong abstraction. A database of memories creates two new problems:

1. **Firehose problem** — `get_context()` dumps everything. No prioritization, no budget.
2. **No communication** — Agents can store data but can't talk to each other. There's no way for backend-agent to tell frontend-agent "I just changed the API."

## Solution

**Smart Channels** — each channel is a shared message stream with:
- Auto-managed context windows (token-budgeted briefings)
- Message types that control compression behavior
- Piggybacked notifications for near real-time awareness
- Extractive compression to keep history useful without LLM dependencies

## Core Concept

A **channel** is a shared context space that Claude agents join to communicate.

| Property | Description |
|---|---|
| Name | Unique identifier (e.g., `fullstack-app`) |
| Description | What this channel coordinates |
| Members | Repos connected to this channel |
| Message stream | Chronological log of all agent messages |
| Context window | Auto-managed briefing within a token budget |
| Pinned messages | Important items that survive compression |

**Agent lifecycle:**
```
Session starts
  → detect repo
  → check which channels this repo belongs to
  → for each channel, ask user: "Connect to #fullstack-app?"
  → user approves
  → agent receives context briefing (summary + pins + recent)
  → agent works, posts updates
  → session ends, agent posts handoff
```

**What changes from v1:**

| v1 Concept | v2 Concept |
|---|---|
| Space | Channel |
| Memory | Message (typed) |
| get_context (firehose) | join_channel (managed briefing) |
| write_memory | post_message |
| recall (search) | search_channel |
| Handoff (separate system) | Handoff message type |
| Correction (separate system) | Correction message type |

## Message Types

| Type | Purpose | Compression |
|---|---|---|
| `chat` | General updates, status | Compressed after 24h |
| `decision` | Architecture/design decisions | Never compressed |
| `convention` | Coding conventions, preferences | Never compressed, auto-pinned |
| `correction` | "Don't do X, do Y" | Never compressed |
| `handoff` | End-of-session summary | Compressed after next session |
| `task` | Task updates, blockers | Compressed when task done |

**Protected types** (`decision`, `convention`, `correction`) are never auto-compressed. They persist in full in every context briefing.

## Near Real-Time Communication

MCP is request-response (no push notifications), but we achieve near real-time through two mechanisms:

**1. Piggybacked notifications:** Every tool response includes new messages since the agent's last check. As long as agents are actively using the MCP server, they see updates.

**2. Explicit polling:** `check_messages` tool for on-demand checking. Agents can be instructed (via CLAUDE.md) to check before major decisions.

## Tool Set (10 tools)

### Channel Management (3)

| Tool | Signature | Description |
|---|---|---|
| `create_channel` | `(name, description, context_budget?)` | Create channel. Default budget: 4000 tokens. |
| `list_channels` | `()` | List all channels with member count, last activity. |
| `connect_repo` | `(channel, repo_path?)` | Connect current repo to a channel. |

### Messaging (3)

| Tool | Signature | Description |
|---|---|---|
| `join_channel` | `(channel)` | Join and receive context briefing within token budget. |
| `post_message` | `(channel, content, type?, pin?)` | Post a message. Response includes new-message notifications. |
| `check_messages` | `(channel?, since?)` | Check for new messages since last read. |

### Search & Management (3)

| Tool | Signature | Description |
|---|---|---|
| `search_channel` | `(query, channel?, type?)` | FTS5 search across messages. |
| `pin_message` | `(message_id)` | Pin message (always in briefing, never compressed). |
| `disconnect_repo` | `(channel, repo_path?)` | Remove repo from channel. |

### Session Continuity (1)

| Tool | Signature | Description |
|---|---|---|
| `handoff` | `(channel, summary, next_steps?)` | Post handoff message to channel. |

## Data Model

### `channels`

| Column | Type | Description |
|---|---|---|
| id | TEXT PK | Channel name |
| description | TEXT NOT NULL | What this channel is for |
| context_budget | INTEGER NOT NULL DEFAULT 4000 | Max tokens for briefing |
| created_at | DATETIME | Auto-set |

### `channel_repos`

| Column | Type | Description |
|---|---|---|
| channel_id | TEXT FK → channels | The channel |
| repo_path | TEXT | Absolute path to repo |
| last_read_at | DATETIME | For new-message tracking |
| joined_at | DATETIME | When connected |
| PK | | (channel_id, repo_path) |

### `messages`

| Column | Type | Description |
|---|---|---|
| id | TEXT PK | UUID |
| channel_id | TEXT FK → channels | Which channel |
| type | TEXT CHECK | `chat`, `decision`, `convention`, `correction`, `handoff`, `task` |
| sender_repo | TEXT | Which repo posted |
| content | TEXT | Message content |
| metadata | TEXT DEFAULT '{}' | JSON — type-specific data |
| is_pinned | INTEGER DEFAULT 0 | Pinned = in briefing, never compressed |
| is_compressed | INTEGER DEFAULT 0 | Folded into a summary? |
| created_at | DATETIME | Auto-set |

### `summaries`

| Column | Type | Description |
|---|---|---|
| id | TEXT PK | UUID |
| channel_id | TEXT FK → channels | Which channel |
| content | TEXT | Summary text |
| message_count | INTEGER | Messages covered |
| period_start | DATETIME | Earliest message |
| period_end | DATETIME | Latest message |
| created_at | DATETIME | Auto-set |

### `messages_fts` (FTS5)

External content table on `messages`. Indexes `content` and `metadata`. Tokenizer: `porter unicode61`. Sync triggers on INSERT/UPDATE/DELETE.

### `schema_version`

Bumped to v2. Migration path from v1 preserved.

## Compression Algorithm

**Trigger:** > 50 uncompressed `chat`/`task`/`handoff` messages in a channel.

**Runs on:** `join_channel` or `post_message` (lazy).

**Never compresses:** Pinned messages, `decision`, `convention`, `correction` types.

**Steps:**
1. Select uncompressed compressible messages older than 24h
2. Group by day (merge adjacent low-activity days)
3. Extract action lines (verb-first sentences, key patterns)
4. Deduplicate (same file/feature → keep latest)
5. Prefix with `[sender_repo]` if multiple senders
6. Store as summary, mark originals as compressed
7. If total summary tokens > 50% of context_budget, merge oldest summaries

**No LLM required.** Pure string processing.

## Context Briefing Assembly

When `join_channel` is called, the briefing is assembled in layers:

```
Layer 1: Channel summary (~100 tokens)
  Channel name, description, member count, message stats

Layer 2: Pinned messages (unlimited — but typically few)
  Decisions, conventions, corrections

Layer 3: Recent messages (fit remaining budget)
  Last N uncompressed messages, newest first

Layer 4: Compressed history (fit remaining budget)
  Summaries from oldest to newest
```

Budget enforcement: layers are filled in order. If Layer 2 (pins) exceeds 50% of budget, a warning is surfaced suggesting the user review pins.

## Tech Stack

Unchanged from v1:
- **Runtime:** Node.js + TypeScript
- **MCP framework:** `@modelcontextprotocol/sdk`
- **Database:** `better-sqlite3` (synchronous, WAL mode)
- **Search:** SQLite FTS5
- **Storage:** `~/.claude-memory/memory.db`

## Migration from v1

v1 data is preserved. Migration strategy:
- `spaces` → rename to `channels`, add `context_budget` column
- `memories` → copy into `messages` with type mapping (category → type)
- `handoffs` → copy into `messages` with type `handoff`
- `corrections` → copy into `messages` with type `correction`
- `space_repos` → rename to `channel_repos`, add `last_read_at`, `joined_at`
- Drop: `memory_versions`, old FTS tables
- Create: `summaries`, new FTS table with triggers

## Recommended CLAUDE.md Addition

```markdown
## Memory Channels
When starting a session, check for available channels with `list_channels()`.
Ask me before joining any channel. Show the channel name and description.
Check for new messages before making cross-repo decisions.
```

## Deferred to v3

- LLM-powered summarization (optional upgrade to extractive compression)
- Channel permissions (read-only members, admin roles)
- Message reactions/acknowledgments
- Channel templates (pre-configured for common project types)
- Auto-discovery (detect related repos without manual connect)
- WebSocket bridge for true real-time (outside MCP protocol)

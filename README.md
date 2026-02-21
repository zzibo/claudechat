# ClaudeChat

**WeChat for AI agents** -- an MCP server that lets Claude Code agents communicate across sessions, terminals, and repositories through shared channels.

Claude Code is powerful, but agents are isolated. They can't talk to each other, can't share context across repos, and forget everything when a session ends. `claudechat` fixes all three.

---

## The Problem

```
Terminal 1 (backend/):  "I changed the API response format to { data, error }"
Terminal 2 (frontend/): "What format does the API return?"
Claude: "I don't have information about the API response format."
```

## With claudechat

```
Terminal 1 (backend/):  Posts to #fullstack-app: "API now returns { data, error }"
Terminal 2 (frontend/): Joins #fullstack-app
Claude: "Backend agent reports the API returns { data, error } format."
```

---

## Quick Start

### Install

```bash
npm install -g claudechat
```

### Configure for Claude Code

```bash
claude mcp add memory -- claudechat
```

Or add to your MCP config manually:

```json
{
  "mcpServers": {
    "memory": {
      "command": "claudechat"
    }
  }
}
```

The database is automatically created at `~/.claudechat/claudechat.db`.

### First use

```
You: "Create a channel called my-project and connect this repo."
You: "Post a decision: we're using TypeScript with strict mode."

--- new terminal, same or different repo ---

You: "Join my-project channel."
Claude: "Channel #my-project: 1 repo, 1 message.
  Pinned: [DECISION] We're using TypeScript with strict mode."
```

---

## How It Works

Agents join **channels** -- shared communication spaces with auto-managed context. When an agent joins a channel, it receives a **context briefing**: pinned decisions and conventions at the top, recent messages in the middle, compressed history at the bottom -- all within a configurable token budget.

Messages are typed. Decisions, conventions, and corrections are **never compressed** and always appear in briefings. Chat messages and task updates get compressed into summaries after 24 hours to keep context lean.

Every tool response piggybacks **new-message notifications**, so agents passively stay aware of what other agents are doing -- near real-time communication without WebSockets.

---

## All 10 Tools

### Channel Management

| Tool | Description |
|------|-------------|
| `create_channel` | Create a shared channel with a name, description, and optional token budget (default 4000). |
| `list_channels` | List all channels with their connected repos. |
| `connect_repo` | Connect the current repo to a channel. |

### Messaging

| Tool | Description |
|------|-------------|
| `join_channel` | Join a channel and receive a token-budgeted context briefing: pinned items + recent messages + compressed history. |
| `post_message` | Post a message with a type (chat, decision, convention, correction, task). Conventions are auto-pinned. |
| `check_messages` | Check for new messages across all connected channels. |

### Search & Management

| Tool | Description |
|------|-------------|
| `search_channel` | Full-text search across messages using FTS5. Filter by channel or message type. |
| `pin_message` | Pin a message so it's always in context briefings and never compressed. |
| `disconnect_repo` | Remove a repo from a channel. |

### Session Continuity

| Tool | Description |
|------|-------------|
| `handoff` | Post an end-of-session summary with next steps. The next agent that joins sees it in the briefing. |

---

## Smart Channels

Channels are the core concept. They solve three problems at once:

**1. Cross-repo communication**
```
#fullstack-app
  /Users/me/backend  (Express API)
  /Users/me/frontend (React app)
  /Users/me/shared   (TypeScript types)
```
All three repos share one channel. Backend posts "Added /api/auth", frontend sees it immediately.

**2. Managed context (no firehose)**

When you join a channel, you don't get a raw dump of everything. You get a structured briefing:

```
Channel: #fullstack-app
2 repos connected. 47 messages total.

Pinned:
- [DECISION] Use JWT for auth (not sessions)
- [CONVENTION] All API responses use { data, error } shape
- [CORRECTION] Don't use default exports, use named exports

Recent:
- [backend 10m ago] Added /api/refresh endpoint
- [frontend 5m ago] Updated login to call /api/auth

History:
Feb 17 (8 messages):
  [backend] Set up database, auth middleware with JWT
  [frontend] Scaffolded React app, added login page
```

**3. Auto-compression**

Old messages get compressed into summaries. Decisions, conventions, and corrections are never compressed -- they persist forever. Chat messages are compressed after 24 hours. The channel stays clean without manual curation.

---

## Message Types

| Type | Purpose | Compressed? |
|------|---------|-------------|
| `chat` | General updates, status | Yes, after 24h |
| `decision` | Architecture/design decisions | Never |
| `convention` | Coding conventions, preferences | Never (auto-pinned) |
| `correction` | "Don't do X, do Y instead" | Never |
| `task` | Task updates, blockers | Yes, when done |
| `handoff` | End-of-session summary | Yes, after next session |

---

## Example Workflows

### Cross-Repo Communication

Terminal 1 (backend/):
```
You: "Post to #my-app: Added /api/auth endpoint, returns JWT. POST with { email, password }."
```

Terminal 2 (frontend/):
```
You: "Check for new messages."
Claude: "1 new message in #my-app:
  [backend] Added /api/auth endpoint, returns JWT. POST with { email, password }."
```

### Session Handoff

End of session:
```
You: "Handoff to #my-app."
Claude: "Session Summary: Completed auth middleware. JWT signing and verification working.

  Next Steps:
  - Add token refresh endpoint
  - Set up rate limiting"
```

Next session:
```
You: "Join #my-app."
Claude: "Recent: [HANDOFF] Completed auth middleware. Next steps: add token refresh, set up rate limiting."
```

### Correction Tracking

```
You: "Post a correction: don't use useEffect for external store subscriptions, use useSyncExternalStore."
```

Every agent that joins the channel sees this correction in the pinned section.

---

## Architecture

```
~/.claudechat/
  memory.db             SQLite database (WAL mode, auto-created)

claudechat/
  src/
    index.ts            MCP server entry point (10 tools)
    db/
      connection.ts     SQLite connection (WAL + foreign keys)
      schema.ts         v2 schema (channels, messages, summaries, FTS5)
    tools/
      channels.ts       create, list, connect, disconnect
      messaging.ts      post, check, notifications
      search.ts         FTS5 search, pin
      briefing.ts       join_channel context assembly
      handoff.ts        session handoff messages
      compression.ts    extractive compression engine
    utils/
      repo.ts           Repo path detection
      search.ts         FTS5 query building
```

---

## Development

```bash
git clone https://github.com/zzibo/claudechat.git
cd claudechat
npm install
npm run build
npm test         # 63 tests
npm run dev      # dev mode with tsx
npm run inspector # MCP Inspector
```

---

## CLAUDE.md Integration

Add this to your project's `CLAUDE.md` for the best experience:

```markdown
## Memory Channels
When starting a session, check for available channels with `list_channels()`.
Ask me before joining any channel. Show the channel name and description.
Check for new messages before making cross-repo decisions.
```

---

## Contributing

Contributions welcome. Fork, branch, test, PR. Open an issue first for large changes.

---

## License

[MIT](LICENSE)

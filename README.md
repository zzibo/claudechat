# claude-memory

**Persistent memory for Claude Code** -- an MCP server that lets Claude remember everything across sessions, terminals, and repositories.

Claude Code is powerful, but it forgets everything when your session ends. `claude-memory` fixes that. It gives Claude a SQLite-backed brain that persists across every session, every terminal, every repo -- and lets you pick up exactly where you left off.

---

## The Problem

```
You: "Remember, we decided to use Zustand instead of Redux for this project."
Claude: "Got it!"

--- new terminal session ---

You: "What state management are we using?"
Claude: "I don't have context about your project's state management choices."
```

## With claude-memory

```
You: "What state management are we using?"
Claude: *recalls memory* "You decided to use Zustand instead of Redux.
  Decision was made on Feb 15 because of simpler boilerplate and
  better TypeScript inference."
```

---

## Quick Start

### Install

```bash
npm install -g claude-memory
```

### Configure for Claude Code

Add to your `~/.claude/claude_desktop_config.json` (or create it):

```json
{
  "mcpServers": {
    "memory": {
      "command": "claude-memory"
    }
  }
}
```

That's it. Claude Code will now have access to all 13 memory tools. The database is automatically created at `~/.claude-memory/memory.db`.

### Verify it works

Start Claude Code and ask:

```
"Write a memory that this project uses TypeScript with strict mode enabled."
```

Close the session. Open a new one and ask:

```
"What do you remember about this project?"
```

It remembers.

---

## How It Works

claude-memory is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server built with TypeScript and better-sqlite3. It exposes 13 tools that Claude Code can call to store, search, and manage persistent memories.

**Search is smart.** Recall uses SQLite FTS5 full-text search with BM25 ranking, boosted by recency and repo affinity. You don't need exact keywords -- natural language queries work.

**Memories are organized into spaces.** A space is a named collection of memories that can span multiple repositories. Your `web-app` frontend repo and `api-server` backend repo can share a `my-saas-project` memory space, so Claude understands the full picture.

---

## All 13 Tools

### Core Memory

| Tool | Description |
|------|-------------|
| `write_memory` | Store a memory with a space, category, title, content, and tags. This is the fundamental write operation. |
| `recall` | Search memories using natural language. Uses FTS5 + BM25 ranking with recency and repo affinity boosts. Returns the most relevant memories. |
| `update_memory` | Edit an existing memory. Automatically creates a version snapshot before overwriting, so nothing is ever truly lost. |
| `delete_memory` | Remove a memory by ID. |
| `get_context` | Auto-load all memories associated with the current repository. Ideal for start-of-session context loading. |

### Session Continuity

| Tool | Description |
|------|-------------|
| `generate_handoff` | Generate an end-of-session summary: what was accomplished, what's in progress, what's next, and any open questions. Stored as a memory for the next session. |
| `receive_handoff` | Start-of-session pickup. Retrieves the most recent handoff for the current repo so Claude can continue exactly where the last session left off. |

### Corrections

| Tool | Description |
|------|-------------|
| `track_correction` | Log when you correct Claude -- what it got wrong, what the right answer is, and the context. Claude learns from its mistakes. |
| `get_corrections` | Retrieve past corrections relevant to the current context so Claude avoids repeating the same errors. |

### Space Management

| Tool | Description |
|------|-------------|
| `create_space` | Create a named memory space (e.g., `my-saas-project`). |
| `list_spaces` | List all spaces and their associated repositories. |
| `add_repo_to_space` | Link a repository to a space. Memories in that space become accessible when working in the repo. |
| `remove_repo_from_space` | Unlink a repository from a space. |

---

## Memory Spaces

Spaces are the organizational backbone of claude-memory. They solve a real problem: most projects span multiple repos, but AI assistants treat each repo as an isolated island.

```
                    my-saas-project (space)
                   /        |        \
           web-app/     api-server/   shared-types/
           (React)      (Express)     (TypeScript)
```

When you work in `web-app/`, Claude can recall memories from the entire `my-saas-project` space -- including API contracts stored while working in `api-server/` and type definitions from `shared-types/`.

### Setting up a space

```
You: "Create a memory space called my-saas-project and link this repo to it."
You: "Also link ~/code/api-server and ~/code/shared-types to that space."
```

Now memories written in any of those repos are searchable from all of them.

---

## Example Workflows

### Session Handoff

The killer feature. At the end of a session:

```
You: "Generate a handoff."
Claude: *creates handoff memory*

  ## Session Handoff - web-app
  ### Completed
  - Migrated auth from JWT to session cookies
  - Updated all API routes to use new auth middleware
  ### In Progress
  - User settings page (component done, API integration remaining)
  ### Next Steps
  - Connect settings form to PUT /api/user/settings
  - Add optimistic updates
  ### Open Questions
  - Should we cache user settings client-side? Need to discuss with team.
```

Next session, in a new terminal:

```
You: "Pick up where we left off."
Claude: *receives handoff* "Last session you migrated auth to session cookies
  and started the user settings page. The component is done -- we need to
  connect it to PUT /api/user/settings and add optimistic updates. There's
  also an open question about client-side caching of user settings."
```

Zero context lost.

### Cross-Repo Knowledge Sharing

Working in `api-server/`:

```
You: "Remember that the /api/user/settings endpoint expects
  { theme, notifications, timezone } in the request body."
```

Later, working in `web-app/`:

```
You: "What does the user settings API expect?"
Claude: *recalls from shared space* "The PUT /api/user/settings endpoint
  expects { theme, notifications, timezone } in the request body."
```

### Correction Tracking

```
You: "No, don't use useEffect for that -- use useSyncExternalStore.
  Track that correction."
Claude: *tracks correction* "Noted: for subscribing to external stores in
  React, use useSyncExternalStore instead of useEffect. Logged for future
  reference."
```

Next time a similar pattern comes up:

```
Claude: *checks corrections* "I recall you previously corrected me on this --
  using useSyncExternalStore instead of useEffect for external store
  subscriptions."
```

---

## Architecture

```
~/.claude-memory/
  memory.db          SQLite database (auto-created)

claude-memory/
  src/
    index.ts          MCP server entry point
    db/
      connection.ts   SQLite connection + migrations
      schema.ts       Table definitions + FTS5 setup
    tools/
      memory.ts       write_memory, recall, update_memory, delete_memory
      context.ts      get_context
      handoff.ts      generate_handoff, receive_handoff
      corrections.ts  track_correction, get_corrections
      spaces.ts       create_space, list_spaces, add/remove_repo_to_space
    utils/
      repo.ts         Repository path detection
      search.ts       FTS5 query building + ranking
```

---

## Development

```bash
# Clone
git clone https://github.com/zzibo/claude-memory.git
cd claude-memory

# Install dependencies
npm install

# Build
npm run build

# Run in dev mode (with tsx)
npm run dev

# Run tests
npm test

# Inspect with MCP Inspector
npm run inspector
```

---

## Roadmap

v2 is coming. Here's what's planned:

- **Pattern detection** -- Claude notices recurring patterns across sessions and surfaces them proactively
- **Decision log** -- First-class support for architectural decisions with context, alternatives considered, and rationale
- **Inter-session messaging** -- Leave notes for your future self (or future Claude)
- **Multi-agent task coordination** -- Multiple Claude Code instances sharing memory for parallel workstreams

---

## Contributing

Contributions are welcome. Here's how:

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/something-useful`)
3. Make your changes
4. Run tests (`npm test`)
5. Open a PR

Please open an issue first for large changes so we can discuss the approach.

---

## License

[MIT](LICENSE) -- see LICENSE file for details.

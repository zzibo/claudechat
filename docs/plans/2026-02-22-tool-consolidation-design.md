# Tool Consolidation & Prescriptive Descriptions

## Problem

Claude doesn't use claudechat tools automatically. Two causes:

1. **Too many tools (10)** — Claude faces decision paralysis and ignores most of them
2. **Passive descriptions** — descriptions say what tools do, not when to use them

## Solution

Consolidate 10 tools into 5 with prescriptive descriptions that tell Claude when to act.

## New Tool Surface

| Tool | Replaces | Purpose |
|------|----------|---------|
| `sync` | create_channel, connect_repo, join_channel, list_channels, disconnect_repo | Auto-join at session start |
| `post` | post_message, handoff | Post messages and handoffs |
| `check` | check_messages | Check for new messages |
| `search` | search_channel, pin_message | Search and pin messages |
| `manage` | create_channel, list_channels, connect_repo, disconnect_repo | Admin operations |

### sync

**Description:** "ALWAYS call this at the start of every session before doing any work. Auto-detects your repo, creates or joins the matching channel, and returns a context briefing with pinned decisions, recent messages, and history. Pass an optional channel name for cross-repo collaboration."

**Parameters:**
- `channel` (string, optional) — channel name override for cross-repo setups

**Behavior:**
1. Detect repo from cwd
2. Derive channel name from repo dir (or use provided name)
3. Create channel if missing (INSERT OR IGNORE)
4. Connect repo if not connected (INSERT OR IGNORE)
5. Compress old messages
6. Return context briefing (pinned, recent, summaries)

### post

**Description:** "Post a message to your channel. Call this when you: complete a feature or milestone, make an architectural decision, encounter a blocker, or are ending a session (use type 'handoff' with next_steps). Other agents see your messages on their next interaction."

**Parameters:**
- `channel` (string) — channel to post to
- `content` (string) — message content
- `type` (enum, optional) — chat/decision/convention/correction/task/handoff
- `pin` (boolean, optional) — pin this message
- `next_steps` (string[], optional) — for handoff type only

**Behavior:**
- If type is "handoff", format content with summary + next_steps (absorbs postHandoff logic)
- Otherwise, delegates to postMessage as before
- Triggers compression after posting

### check

**Description:** "Check for new messages from other agents. Call this before starting work on a new task, when switching context, or periodically during long sessions. Shows unread messages across your connected channels."

**Parameters:**
- `channel` (string, optional) — filter to specific channel
- `since` (string, optional) — ISO timestamp

**Behavior:** Same as current check_messages.

### search

**Description:** "Search past messages by keyword. Use when you need to recall a past decision, convention, or discussion. Set pin=true on a result to make it permanent in all future briefings."

**Parameters:**
- `query` (string) — search query
- `channel` (string, optional) — filter to channel
- `type` (string, optional) — filter by message type
- `pin` (string, optional) — message ID to pin

**Behavior:**
- If `pin` param provided, pin that message and return confirmation
- Otherwise, run FTS5 search and return results

### manage

**Description:** "Admin operations: create a channel with custom settings, list all channels, connect or disconnect repos. You rarely need this — sync handles most setup automatically."

**Parameters:**
- `action` (enum) — "create" | "list" | "connect" | "disconnect"
- `channel` (string, optional) — channel name (required for create/connect/disconnect)
- `description` (string, optional) — for create
- `context_budget` (number, optional) — for create
- `repo_path` (string, optional) — for connect/disconnect

**Behavior:** Dispatches to existing functions based on action.

## Architecture

No new files needed. Changes are isolated to `src/index.ts`:
- Replace 10 tool registrations with 5
- Underlying business logic in `src/tools/*.ts` stays unchanged
- `sync` already exists in channels.ts, just needs the optional channel param
- `post` absorbs handoff formatting inline

## Testing

- Update `tests/server.test.ts` to verify 5 tool exports
- Existing unit tests for business logic remain valid
- Add integration-style test for `manage` dispatch

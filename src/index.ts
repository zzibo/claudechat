#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getConnection } from "./db/connection.js";
import { applySchema } from "./db/schema.js";
import {
  createChannel,
  listChannels,
  connectRepo,
  disconnectRepo,
  syncChannel,
} from "./tools/channels.js";
import {
  postMessage,
  checkMessages,
  getNewMessageNotifications,
} from "./tools/messaging.js";
import { searchChannel, pinMessage } from "./tools/search.js";
import { joinChannel } from "./tools/briefing.js";
import { postHandoff } from "./tools/handoff.js";
import { compressChannel } from "./tools/compression.js";
import { detectRepo } from "./utils/repo.js";

const db = getConnection();
applySchema(db);

const server = new McpServer({
  name: "claudechat",
  version: "0.2.0",
});

// Helper: format notification banner
function notificationBanner(repoPath: string): string {
  const notifs = getNewMessageNotifications(db, repoPath);
  if (notifs.length === 0) return "";
  const lines = notifs.map(
    (n) =>
      `- [${n.sender_repo.split("/").pop()}] ${n.content.slice(0, 120)}`
  );
  return `\n\n📬 ${notifs.length} new message(s):\n${lines.join("\n")}`;
}

// --- Sync (primary entry point) ---

server.tool(
  "sync",
  "Auto-detect repo, create/join channel, and get context briefing. Call this at session start — it handles everything.",
  {},
  async () => {
    const repo = detectRepo();
    const channelName = syncChannel(db, repo);
    compressChannel(db, channelName);
    const briefing = joinChannel(db, channelName, repo);

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

    return {
      content: [{ type: "text", text }],
    };
  }
);

// --- Channel Management ---

server.tool(
  "create_channel",
  "Create a new shared channel for agent communication",
  {
    name: z.string().describe("Unique channel name (e.g., 'fullstack-app')"),
    description: z.string().describe("What this channel coordinates"),
    context_budget: z
      .number()
      .optional()
      .describe("Max tokens for context briefing (default 4000)"),
  },
  async ({ name, description, context_budget }) => {
    const ch = createChannel(db, name, description, context_budget);
    return {
      content: [
        {
          type: "text",
          text: `Channel #${ch.id} created.\n\n${JSON.stringify(ch, null, 2)}`,
        },
      ],
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
        content: [
          {
            type: "text",
            text: "No channels exist yet. Use create_channel to create one.",
          },
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
);

server.tool(
  "connect_repo",
  "Connect this repo to a channel so it can send and receive messages",
  {
    channel: z.string().describe("Channel name to connect to"),
    repo_path: z
      .string()
      .optional()
      .describe("Repo path (auto-detected if omitted)"),
  },
  async ({ channel, repo_path }) => {
    const repo = repo_path ?? detectRepo();
    connectRepo(db, channel, repo);
    return {
      content: [
        { type: "text", text: `Connected '${repo}' to #${channel}.` },
      ],
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
    type: z
      .enum(["chat", "decision", "convention", "correction", "task"])
      .optional()
      .describe("Message type (default: chat)"),
    pin: z
      .boolean()
      .optional()
      .describe("Pin this message (always in briefings, never compressed)"),
  },
  async ({ channel, content, type, pin }) => {
    const repo = detectRepo();
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

server.tool(
  "check_messages",
  "Check for new messages across your connected channels",
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
          `${i + 1}. [#${m.channel_id}] [${m.type}] ${m.content.slice(0, 200)}\n   From: ${m.sender_repo} | ${m.created_at}`
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

server.tool(
  "pin_message",
  "Pin a message so it's always included in context briefings",
  {
    message_id: z.string().describe("UUID of the message to pin"),
  },
  async ({ message_id }) => {
    const msg = pinMessage(db, message_id);
    return {
      content: [
        {
          type: "text",
          text: `Message pinned: "${msg.content.slice(0, 100)}"`,
        },
      ],
    };
  }
);

server.tool(
  "disconnect_repo",
  "Remove a repo from a channel",
  {
    channel: z.string().describe("Channel name"),
    repo_path: z
      .string()
      .optional()
      .describe("Repo path (auto-detected if omitted)"),
  },
  async ({ channel, repo_path }) => {
    const repo = repo_path ?? detectRepo();
    disconnectRepo(db, channel, repo);
    return {
      content: [
        { type: "text", text: `Disconnected '${repo}' from #${channel}.` },
      ],
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
    next_steps: z
      .array(z.string())
      .optional()
      .describe("Suggested next steps"),
  },
  async ({ channel, summary, next_steps }) => {
    const repo = detectRepo();
    const msg = postHandoff(db, {
      channel,
      summary,
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
);

// --- Start Server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ClaudeChat running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

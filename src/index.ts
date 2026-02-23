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
import type { ChannelBriefing } from "./tools/briefing.js";
import { postHandoff } from "./tools/handoff.js";
import { compressChannel } from "./tools/compression.js";
import { detectRepo } from "./utils/repo.js";

const db = getConnection();
applySchema(db);

const server = new McpServer({
  name: "claudechat",
  version: "0.3.0",
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

// Helper: format briefing response
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

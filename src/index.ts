#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getConnection } from "./db/connection.js";
import { applySchema } from "./db/schema.js";
import { syncChannel } from "./tools/channels.js";
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
  version: "0.5.0",
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

// Helper: format briefing response with handoff-first priority
function formatBriefing(briefing: ChannelBriefing, channelName: string): string {
  let text = `# Channel: #${briefing.channel.id}\n`;
  text += `${briefing.channel.description}\n`;
  text += `${briefing.channel.member_count} repos connected. ${briefing.channel.total_messages} messages total.\n`;

  // Priority 1: Most recent handoff (structured checkpoint)
  const handoff = briefing.recent.find((m) => m.type === "handoff");
  if (handoff) {
    text += `\n🔄 Last Handoff (${handoff.created_at}):\n`;
    text += `${handoff.content}\n`;
  }

  // Priority 2: Pinned messages
  if (briefing.pinned.length > 0) {
    text += `\n📌 Pinned:\n`;
    text += briefing.pinned
      .map((p) => `- [${p.type.toUpperCase()}] ${p.content}`)
      .join("\n");
    text += "\n";
  }

  // Priority 3: Recent messages (excluding handoff already shown)
  const recentNonHandoff = briefing.recent.filter((m) => m.type !== "handoff");
  if (recentNonHandoff.length > 0) {
    text += `\nRecent:\n`;
    text += recentNonHandoff
      .map(
        (r) =>
          `- [${r.sender_repo.split("/").pop()} ${r.created_at}] ${r.content.slice(0, 200)}`
      )
      .join("\n");
    text += "\n";
  }

  // Priority 4: Compressed history
  if (briefing.summaries.length > 0) {
    text += `\nHistory:\n`;
    text += briefing.summaries.map((s) => s.content).join("\n\n");
    text += "\n";
  }

  // Nudge: remind agent to handoff before session ends
  text += `\n💡 Remember to call \`handoff\` with a summary before your session ends.`;

  return text;
}

// --- sync ---

server.tool(
  "sync",
  "ALWAYS call this at the start of every session before doing any work. Auto-detects your repo, creates or joins the matching channel, and returns a context briefing with the last handoff, pinned decisions, and recent messages. Pass an optional channel name for cross-repo collaboration.",
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
      content: [{ type: "text", text: formatBriefing(briefing, channelName) }],
    };
  }
);

// --- post ---

server.tool(
  "post",
  "Post a message to your channel. Call this when you: complete a feature or milestone, make an architectural decision, encounter a blocker, or need to share context with other agents.",
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

// --- check ---

server.tool(
  "check",
  "Check for new messages from other agents. Call this before starting work on a new task, when switching context, or periodically during long sessions.",
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
  "Search past messages by keyword. Use when you need to recall a past decision, convention, or discussion.",
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

// --- pin ---

server.tool(
  "pin",
  "Pin a message so it's always included in context briefings and never compressed. Use this to preserve important decisions, conventions, or context that future sessions need.",
  {
    message_id: z.string().describe("UUID of the message to pin"),
  },
  async ({ message_id }) => {
    const msg = pinMessage(db, message_id);
    return {
      content: [
        {
          type: "text",
          text: `📌 Pinned: "${msg.content.slice(0, 100)}"`,
        },
      ],
    };
  }
);

// --- handoff ---

server.tool(
  "handoff",
  "Post a structured end-of-session checkpoint. ALWAYS call this before your session ends. Captures what happened and what should happen next so the next session can pick up seamlessly.",
  {
    channel: z.string().describe("Channel to post handoff to"),
    summary: z.string().describe("What happened this session"),
    next_steps: z
      .array(z.string())
      .optional()
      .describe("Suggested next steps for the next session"),
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
          text: `✅ Handoff posted to #${channel}.\n\n${msg.content}`,
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

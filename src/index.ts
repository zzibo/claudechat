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

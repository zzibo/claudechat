import type Database from "better-sqlite3";
import type { Message } from "./messaging.js";
import { postMessage } from "./messaging.js";

export interface PostHandoffInput {
  channel: string;
  summary: string;
  sender_repo: string;
  next_steps?: string[];
}

export function postHandoff(
  db: Database.Database,
  input: PostHandoffInput
): Message {
  let content = `Session Summary: ${input.summary}`;

  if (input.next_steps && input.next_steps.length > 0) {
    content += `\n\nNext Steps:\n${input.next_steps.map((s) => `- ${s}`).join("\n")}`;
  }

  return postMessage(db, {
    channel: input.channel,
    content,
    sender_repo: input.sender_repo,
    type: "handoff",
    metadata: {
      summary: input.summary,
      next_steps: input.next_steps ?? [],
    },
  });
}

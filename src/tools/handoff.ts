import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface Handoff {
  id: string;
  repo_path: string;
  space_id: string | null;
  summary: string;
  completed: string;
  in_progress: string;
  next_steps: string;
  pending_decisions: string;
  context_notes: string;
  created_at: string;
  is_active: number;
}

export interface GenerateHandoffInput {
  repo_path: string;
  space_id?: string;
  summary: string;
  completed: string[];
  in_progress: string[];
  next_steps: string[];
  pending_decisions?: string[];
  context_notes?: string;
}

export function generateHandoff(
  db: Database.Database,
  input: GenerateHandoffInput
): Handoff {
  const id = randomUUID();

  db.prepare(
    "UPDATE handoffs SET is_active = 0 WHERE repo_path = ? AND is_active = 1"
  ).run(input.repo_path);

  db.prepare(
    `INSERT INTO handoffs (id, repo_path, space_id, summary, completed, in_progress, next_steps, pending_decisions, context_notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.repo_path,
    input.space_id ?? null,
    input.summary,
    JSON.stringify(input.completed),
    JSON.stringify(input.in_progress),
    JSON.stringify(input.next_steps),
    JSON.stringify(input.pending_decisions ?? []),
    input.context_notes ?? ""
  );

  return db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id) as Handoff;
}

export function receiveHandoff(
  db: Database.Database,
  repoPath: string
): Handoff | null {
  const handoff = db
    .prepare(
      "SELECT * FROM handoffs WHERE repo_path = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1"
    )
    .get(repoPath) as Handoff | undefined;

  return handoff ?? null;
}

import type Database from "better-sqlite3";
import type { Memory } from "./memory.js";

export interface ContextResult {
  repo_path: string;
  spaces: { id: string; description: string }[];
  memories: Memory[];
}

export function getContext(
  db: Database.Database,
  repoPath: string
): ContextResult {
  const spaceRows = db
    .prepare(
      `SELECT s.id, s.description
       FROM space_repos sr
       JOIN spaces s ON s.id = sr.space_id
       WHERE sr.repo_path = ?`
    )
    .all(repoPath) as { id: string; description: string }[];

  if (spaceRows.length === 0) {
    return { repo_path: repoPath, spaces: [], memories: [] };
  }

  const placeholders = spaceRows.map(() => "?").join(", ");
  const spaceIds = spaceRows.map((s) => s.id);

  const memories = db
    .prepare(
      `SELECT * FROM memories
       WHERE space_id IN (${placeholders})
       ORDER BY updated_at DESC`
    )
    .all(...spaceIds) as Memory[];

  return {
    repo_path: repoPath,
    spaces: spaceRows,
    memories,
  };
}

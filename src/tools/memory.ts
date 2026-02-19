import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { buildFtsQuery } from "../utils/search.js";

export interface Memory {
  id: string;
  space_id: string;
  category: string;
  title: string;
  content: string;
  source_repo: string;
  tags: string;
  created_at: string;
  updated_at: string;
}

export interface WriteMemoryInput {
  space: string;
  category: string;
  title: string;
  content: string;
  source_repo: string;
  tags?: string;
}

export interface RecallInput {
  query: string;
  space?: string;
  category?: string;
  tags?: string;
  limit?: number;
  current_repo?: string;
}

export interface UpdateMemoryInput {
  title?: string;
  content?: string;
  tags?: string;
}

export function writeMemory(
  db: Database.Database,
  input: WriteMemoryInput
): Memory {
  const id = randomUUID();
  const tags = input.tags ?? "";

  db.prepare(
    `INSERT INTO memories (id, space_id, category, title, content, source_repo, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.space, input.category, input.title, input.content, input.source_repo, tags);

  return db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Memory;
}

export function recall(
  db: Database.Database,
  input: RecallInput
): Memory[] {
  const ftsQuery = buildFtsQuery(input.query);
  if (!ftsQuery) return [];

  const limit = input.limit ?? 10;

  let sql = `
    SELECT
      memories.*,
      bm25(memories_fts, 10.0, 1.0, 5.0) as bm25_score,
      CASE
        WHEN memories.created_at >= datetime('now', '-7 days') THEN 2.0
        WHEN memories.created_at >= datetime('now', '-30 days') THEN 1.5
        ELSE 1.0
      END as recency_boost,
      CASE
        WHEN memories.source_repo = ? THEN 1.5
        ELSE 1.0
      END as affinity_boost
    FROM memories_fts
    JOIN memories ON memories.rowid = memories_fts.rowid
    WHERE memories_fts MATCH ?
  `;

  const params: (string | number)[] = [input.current_repo ?? "", ftsQuery];

  if (input.space) {
    sql += " AND memories.space_id = ?";
    params.push(input.space);
  }

  if (input.category) {
    sql += " AND memories.category = ?";
    params.push(input.category);
  }

  if (input.tags) {
    const tagList = input.tags.split(",").map((t) => t.trim());
    for (const tag of tagList) {
      sql += " AND memories.tags LIKE ?";
      params.push(`%${tag}%`);
    }
  }

  sql += `
    ORDER BY (bm25_score * recency_boost * affinity_boost)
    LIMIT ?
  `;
  params.push(limit);

  return db.prepare(sql).all(...params) as Memory[];
}

export function updateMemory(
  db: Database.Database,
  id: string,
  input: UpdateMemoryInput
): Memory {
  const current = db
    .prepare("SELECT * FROM memories WHERE id = ?")
    .get(id) as Memory;

  if (!current) {
    throw new Error(`Memory '${id}' not found`);
  }

  db.prepare(
    `INSERT INTO memory_versions (id, memory_id, title, content, tags)
     VALUES (?, ?, ?, ?, ?)`
  ).run(randomUUID(), id, current.title, current.content, current.tags);

  const title = input.title ?? current.title;
  const content = input.content ?? current.content;
  const tags = input.tags ?? current.tags;

  db.prepare(
    `UPDATE memories SET title = ?, content = ?, tags = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(title, content, tags, id);

  return db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Memory;
}

export function deleteMemory(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM memories WHERE id = ?").run(id);
}

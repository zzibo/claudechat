import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { buildFtsQuery } from "../utils/search.js";

export interface Correction {
  id: string;
  space_id: string | null;
  context: string;
  wrong_behavior: string;
  correct_behavior: string;
  source_repo: string;
  tags: string;
  created_at: string;
}

export interface TrackCorrectionInput {
  context: string;
  wrong_behavior: string;
  correct_behavior: string;
  source_repo: string;
  space_id?: string;
  tags?: string;
}

export interface GetCorrectionsInput {
  context?: string;
  tags?: string;
  limit?: number;
}

export function trackCorrection(
  db: Database.Database,
  input: TrackCorrectionInput
): Correction {
  const id = randomUUID();

  db.prepare(
    `INSERT INTO corrections (id, space_id, context, wrong_behavior, correct_behavior, source_repo, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.space_id ?? null,
    input.context,
    input.wrong_behavior,
    input.correct_behavior,
    input.source_repo,
    input.tags ?? ""
  );

  return db
    .prepare("SELECT * FROM corrections WHERE id = ?")
    .get(id) as Correction;
}

export function getCorrections(
  db: Database.Database,
  input: GetCorrectionsInput
): Correction[] {
  const limit = input.limit ?? 10;

  if (input.context) {
    const ftsQuery = buildFtsQuery(input.context);
    if (!ftsQuery) return [];

    let sql = `
      SELECT corrections.*
      FROM corrections_fts
      JOIN corrections ON corrections.rowid = corrections_fts.rowid
      WHERE corrections_fts MATCH ?
    `;
    const params: (string | number)[] = [ftsQuery];

    if (input.tags) {
      const tagList = input.tags.split(",").map((t) => t.trim());
      for (const tag of tagList) {
        sql += " AND corrections.tags LIKE ?";
        params.push(`%${tag}%`);
      }
    }

    sql += " ORDER BY bm25(corrections_fts) LIMIT ?";
    params.push(limit);

    return db.prepare(sql).all(...params) as Correction[];
  }

  let sql = "SELECT * FROM corrections";
  const params: (string | number)[] = [];

  if (input.tags) {
    const tagList = input.tags.split(",").map((t) => t.trim());
    const conditions = tagList.map(() => "tags LIKE ?");
    sql += " WHERE " + conditions.join(" AND ");
    params.push(...tagList.map((t) => `%${t}%`));
  }

  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);

  return db.prepare(sql).all(...params) as Correction[];
}

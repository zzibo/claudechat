import type Database from "better-sqlite3";

export function applySchema(db: Database.Database): void {
  const hasVersion = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    )
    .get();

  if (hasVersion) {
    return;
  }

  db.exec(`
    CREATE TABLE schema_version (
      version INTEGER NOT NULL
    );
    INSERT INTO schema_version (version) VALUES (1);

    CREATE TABLE spaces (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      category TEXT NOT NULL CHECK (category IN ('convention', 'decision', 'context', 'preference', 'task')),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source_repo TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_memories_space ON memories(space_id);
    CREATE INDEX idx_memories_category ON memories(category);
    CREATE INDEX idx_memories_source_repo ON memories(source_repo);

    CREATE TABLE memory_versions (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_memory_versions_memory ON memory_versions(memory_id);

    CREATE TABLE space_repos (
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      repo_path TEXT NOT NULL,
      PRIMARY KEY (space_id, repo_path)
    );

    CREATE INDEX idx_space_repos_repo ON space_repos(repo_path);

    CREATE TABLE handoffs (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      space_id TEXT REFERENCES spaces(id) ON DELETE SET NULL,
      summary TEXT NOT NULL,
      completed TEXT NOT NULL DEFAULT '[]',
      in_progress TEXT NOT NULL DEFAULT '[]',
      next_steps TEXT NOT NULL DEFAULT '[]',
      pending_decisions TEXT NOT NULL DEFAULT '[]',
      context_notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX idx_handoffs_repo ON handoffs(repo_path);
    CREATE INDEX idx_handoffs_active ON handoffs(repo_path, is_active);

    CREATE TABLE corrections (
      id TEXT PRIMARY KEY,
      space_id TEXT REFERENCES spaces(id) ON DELETE SET NULL,
      context TEXT NOT NULL,
      wrong_behavior TEXT NOT NULL,
      correct_behavior TEXT NOT NULL,
      source_repo TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_corrections_space ON corrections(space_id);
    CREATE INDEX idx_corrections_repo ON corrections(source_repo);

    CREATE VIRTUAL TABLE memories_fts USING fts5(
      title,
      content,
      tags,
      content = 'memories',
      content_rowid = 'rowid',
      tokenize = 'porter unicode61'
    );

    CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, title, content, tags)
      VALUES (new.rowid, new.title, new.content, new.tags);
    END;

    CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
      VALUES ('delete', old.rowid, old.title, old.content, old.tags);
    END;

    CREATE TRIGGER memories_fts_update AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
      VALUES ('delete', old.rowid, old.title, old.content, old.tags);
      INSERT INTO memories_fts(rowid, title, content, tags)
      VALUES (new.rowid, new.title, new.content, new.tags);
    END;

    CREATE VIRTUAL TABLE corrections_fts USING fts5(
      context,
      wrong_behavior,
      correct_behavior,
      content = 'corrections',
      content_rowid = 'rowid',
      tokenize = 'porter unicode61'
    );

    CREATE TRIGGER corrections_fts_insert AFTER INSERT ON corrections BEGIN
      INSERT INTO corrections_fts(rowid, context, wrong_behavior, correct_behavior)
      VALUES (new.rowid, new.context, new.wrong_behavior, new.correct_behavior);
    END;

    CREATE TRIGGER corrections_fts_delete AFTER DELETE ON corrections BEGIN
      INSERT INTO corrections_fts(corrections_fts, rowid, context, wrong_behavior, correct_behavior)
      VALUES ('delete', old.rowid, old.context, old.wrong_behavior, old.correct_behavior);
    END;

    CREATE TRIGGER corrections_fts_update AFTER UPDATE ON corrections BEGIN
      INSERT INTO corrections_fts(corrections_fts, rowid, context, wrong_behavior, correct_behavior)
      VALUES ('delete', old.rowid, old.context, old.wrong_behavior, old.correct_behavior);
      INSERT INTO corrections_fts(rowid, context, wrong_behavior, correct_behavior)
      VALUES (new.rowid, new.context, new.wrong_behavior, new.correct_behavior);
    END;
  `);
}

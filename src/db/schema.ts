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
    INSERT INTO schema_version (version) VALUES (2);

    CREATE TABLE channels (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      context_budget INTEGER NOT NULL DEFAULT 4000,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE channel_repos (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      repo_path TEXT NOT NULL,
      last_read_at TEXT NOT NULL DEFAULT (datetime('now')),
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (channel_id, repo_path)
    );

    CREATE INDEX idx_channel_repos_repo ON channel_repos(repo_path);

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('chat', 'decision', 'convention', 'correction', 'handoff', 'task')),
      sender_repo TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      is_pinned INTEGER NOT NULL DEFAULT 0,
      is_compressed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_messages_channel ON messages(channel_id);
    CREATE INDEX idx_messages_type ON messages(type);
    CREATE INDEX idx_messages_created ON messages(channel_id, created_at);
    CREATE INDEX idx_messages_uncompressed ON messages(channel_id, is_compressed, created_at);

    CREATE TABLE summaries (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_summaries_channel ON summaries(channel_id, period_start);

    CREATE VIRTUAL TABLE messages_fts USING fts5(
      content,
      metadata,
      content = 'messages',
      content_rowid = 'rowid',
      tokenize = 'porter unicode61'
    );

    CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content, metadata)
      VALUES (new.rowid, new.content, new.metadata);
    END;

    CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, metadata)
      VALUES ('delete', old.rowid, old.content, old.metadata);
    END;

    CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, metadata)
      VALUES ('delete', old.rowid, old.content, old.metadata);
      INSERT INTO messages_fts(rowid, content, metadata)
      VALUES (new.rowid, new.content, new.metadata);
    END;
  `);
}

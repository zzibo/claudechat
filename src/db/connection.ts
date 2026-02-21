import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const MEMORY_DIR = join(homedir(), ".claudechat");
const DB_PATH = join(MEMORY_DIR, "claudechat.db");

export function getConnection(dbPath?: string): Database.Database {
  const path = dbPath ?? DB_PATH;

  if (path !== ":memory:") {
    mkdirSync(join(path, ".."), { recursive: true });
  }

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

import type Database from "better-sqlite3";

export interface Channel {
  id: string;
  description: string;
  context_budget: number;
  created_at: string;
  repos: string[];
}

export function createChannel(
  db: Database.Database,
  name: string,
  description: string,
  contextBudget?: number
): Channel {
  const budget = contextBudget ?? 4000;
  db.prepare(
    "INSERT INTO channels (id, description, context_budget) VALUES (?, ?, ?)"
  ).run(name, description, budget);

  const row = db
    .prepare("SELECT * FROM channels WHERE id = ?")
    .get(name) as any;

  return { ...row, repos: [] };
}

export function listChannels(db: Database.Database): Channel[] {
  const channels = db
    .prepare("SELECT * FROM channels ORDER BY created_at DESC")
    .all() as any[];

  return channels.map((ch) => {
    const repos = db
      .prepare(
        "SELECT repo_path FROM channel_repos WHERE channel_id = ? ORDER BY joined_at"
      )
      .all(ch.id)
      .map((r: any) => r.repo_path);

    return { ...ch, repos };
  });
}

export function connectRepo(
  db: Database.Database,
  channelName: string,
  repoPath: string
): void {
  const channel = db
    .prepare("SELECT id FROM channels WHERE id = ?")
    .get(channelName);
  if (!channel) {
    throw new Error(`Channel '${channelName}' does not exist`);
  }
  db.prepare(
    "INSERT OR IGNORE INTO channel_repos (channel_id, repo_path) VALUES (?, ?)"
  ).run(channelName, repoPath);
}

export function disconnectRepo(
  db: Database.Database,
  channelName: string,
  repoPath: string
): void {
  db.prepare(
    "DELETE FROM channel_repos WHERE channel_id = ? AND repo_path = ?"
  ).run(channelName, repoPath);
}

export function syncChannel(
  db: Database.Database,
  repoPath: string
): string {
  // Derive channel name from repo directory name
  const channelName = repoPath.split("/").filter(Boolean).pop() ?? "default";

  // Create channel if it doesn't exist
  db.prepare(
    "INSERT OR IGNORE INTO channels (id, description, context_budget) VALUES (?, ?, ?)"
  ).run(channelName, `Auto-created channel for ${channelName}`, 4000);

  // Connect repo if not already connected
  db.prepare(
    "INSERT OR IGNORE INTO channel_repos (channel_id, repo_path) VALUES (?, ?)"
  ).run(channelName, repoPath);

  return channelName;
}

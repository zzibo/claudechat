import type Database from "better-sqlite3";

export interface Space {
  id: string;
  description: string;
  created_at: string;
  repos: string[];
}

export function createSpace(
  db: Database.Database,
  name: string,
  description: string
): Space {
  db.prepare("INSERT INTO spaces (id, description) VALUES (?, ?)").run(
    name,
    description
  );

  const row = db.prepare("SELECT * FROM spaces WHERE id = ?").get(name) as {
    id: string;
    description: string;
    created_at: string;
  };

  return { ...row, repos: [] };
}

export function listSpaces(db: Database.Database): Space[] {
  const spaces = db.prepare("SELECT * FROM spaces ORDER BY id").all() as {
    id: string;
    description: string;
    created_at: string;
  }[];

  return spaces.map((space) => {
    const repos = db
      .prepare("SELECT repo_path FROM space_repos WHERE space_id = ?")
      .all(space.id) as { repo_path: string }[];

    return {
      ...space,
      repos: repos.map((r) => r.repo_path),
    };
  });
}

export function addRepoToSpace(
  db: Database.Database,
  spaceName: string,
  repoPath: string
): void {
  const space = db.prepare("SELECT id FROM spaces WHERE id = ?").get(spaceName);
  if (!space) {
    throw new Error(`Space '${spaceName}' does not exist`);
  }

  db.prepare(
    "INSERT OR IGNORE INTO space_repos (space_id, repo_path) VALUES (?, ?)"
  ).run(spaceName, repoPath);
}

export function removeRepoFromSpace(
  db: Database.Database,
  spaceName: string,
  repoPath: string
): void {
  db.prepare(
    "DELETE FROM space_repos WHERE space_id = ? AND repo_path = ?"
  ).run(spaceName, repoPath);
}

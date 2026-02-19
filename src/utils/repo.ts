export function detectRepo(repoPath?: string): string {
  if (repoPath) {
    return repoPath;
  }
  return process.cwd();
}

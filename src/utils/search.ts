export function sanitizeFtsQuery(query: string): string {
  return query
    .replace(/[":*()\^{}~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildFtsQuery(query: string): string {
  const sanitized = sanitizeFtsQuery(query);
  const words = sanitized.split(" ").filter((w) => w.length > 0);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0];
  return words.join(" OR ");
}

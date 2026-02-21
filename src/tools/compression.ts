import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

const COMPRESSION_THRESHOLD = 50;
const ACTION_VERBS =
  /^(Added|Fixed|Updated|Removed|Refactored|Created|Implemented|Deployed|Merged|Resolved|Configured|Migrated|Installed|Built|Set up|Completed)/i;
const KEY_PATTERNS =
  /\b(done|complete|merged|deployed|shipped|released|finished|resolved)\b/i;

export function extractActionLines(lines: string[]): string[] {
  return lines.filter(
    (line) => ACTION_VERBS.test(line.trim()) || KEY_PATTERNS.test(line)
  );
}

interface CompressResult {
  compressed: number;
  summariesCreated: number;
}

export function compressChannel(
  db: Database.Database,
  channelId: string
): CompressResult {
  // Count compressible messages older than 24h
  const compressible = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM messages
       WHERE channel_id = ?
         AND is_compressed = 0
         AND is_pinned = 0
         AND type IN ('chat', 'task', 'handoff')
         AND created_at < datetime('now', '-1 day')`
    )
    .get(channelId) as any;

  if (compressible.cnt < COMPRESSION_THRESHOLD) {
    return { compressed: 0, summariesCreated: 0 };
  }

  // Fetch compressible messages grouped by date
  const messages = db
    .prepare(
      `SELECT id, content, sender_repo, created_at, date(created_at) as msg_date
       FROM messages
       WHERE channel_id = ?
         AND is_compressed = 0
         AND is_pinned = 0
         AND type IN ('chat', 'task', 'handoff')
         AND created_at < datetime('now', '-1 day')
       ORDER BY created_at ASC`
    )
    .all(channelId) as any[];

  // Group by date
  const groups = new Map<string, typeof messages>();
  for (const msg of messages) {
    const date = msg.msg_date;
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date)!.push(msg);
  }

  let totalCompressed = 0;
  let summariesCreated = 0;

  for (const [date, msgs] of groups) {
    // Extract action lines from message contents
    const contentLines = msgs.map((m: any) => m.content);
    let actionLines = extractActionLines(contentLines);

    // If no action lines extracted, fall back to first sentence of each message
    if (actionLines.length === 0) {
      actionLines = contentLines.map((c: string) => {
        const firstSentence = c.split(/[.\n]/)[0].trim();
        return firstSentence.length > 100
          ? firstSentence.slice(0, 100) + "..."
          : firstSentence;
      });
    }

    // Deduplicate
    const unique = [...new Set(actionLines)];

    // Check if multiple senders
    const senders = new Set(msgs.map((m: any) => m.sender_repo));
    const multiSender = senders.size > 1;

    // Build summary
    let summaryLines: string[];
    if (multiSender) {
      const bySender = new Map<string, string[]>();
      for (const msg of msgs) {
        if (!bySender.has(msg.sender_repo))
          bySender.set(msg.sender_repo, []);
        bySender.get(msg.sender_repo)!.push(msg.content);
      }
      summaryLines = [];
      for (const [sender, contents] of bySender) {
        const senderActions = extractActionLines(contents);
        const senderName = sender.split("/").pop() || sender;
        if (senderActions.length > 0) {
          summaryLines.push(`[${senderName}] ${senderActions.join(", ")}`);
        } else {
          summaryLines.push(`[${senderName}] ${contents.length} messages`);
        }
      }
    } else {
      summaryLines = unique.slice(0, 10).map((l) => `• ${l}`);
    }

    const summaryContent = `${date} (${msgs.length} messages):\n${summaryLines.join("\n")}`;

    // Insert summary
    db.prepare(
      `INSERT INTO summaries (id, channel_id, content, message_count, period_start, period_end)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      channelId,
      summaryContent,
      msgs.length,
      msgs[0].created_at,
      msgs[msgs.length - 1].created_at
    );
    summariesCreated++;

    // Mark messages as compressed
    for (const msg of msgs) {
      db.prepare(
        "UPDATE messages SET is_compressed = 1 WHERE id = ?"
      ).run(msg.id);
    }
    totalCompressed += msgs.length;
  }

  return { compressed: totalCompressed, summariesCreated };
}

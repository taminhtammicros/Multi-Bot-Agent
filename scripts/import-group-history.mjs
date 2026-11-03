import "dotenv/config";
import { query, pool, migrate } from "../src/db.ts";
import { recordGroupMessage, sourceTime } from "../src/group-brain.ts";
// Import only individually attributed user messages. Never infer account from a conversation title.
let imported = 0,
  skipped = 0,
  cursor = "";
try {
  await migrate();
  while (true) {
    const rows = (
      await query(
        `SELECT m.*,c.thread_id FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE c.source='zalo' AND c.thread_type=1 AND m.role='user' AND m.id::text>$1 ORDER BY m.id::text LIMIT 200`,
        [cursor],
      )
    ).rows;
    if (!rows.length) break;
    for (const row of rows) {
      cursor = row.id;
      if (
        !/^\d{1,30}$/.test(row.source_account_id || "") ||
        !/^\d{1,30}$/.test(row.thread_id || "") ||
        !/^\d{1,30}$/.test(row.zalo_reply?.senderId || "")
      ) {
        skipped++;
        continue;
      }
      const id =
        row.zalo_reply?.quote?.msgId ||
        row.external_id?.split(":").at(-1) ||
        "legacy:" + row.id;
      const stored = await recordGroupMessage(
        { accountId: row.source_account_id, groupId: row.thread_id },
        {
          externalId: id,
          senderId: row.zalo_reply.senderId,
          senderName: row.zalo_reply.senderName || row.zalo_reply.senderId,
          content: row.content,
          occurredAt: row.zalo_reply.quote?.ts
            ? sourceTime(row.zalo_reply.quote.ts)
            : new Date(row.created_at),
        },
      );
      if (stored) imported++;
    }
  }
  console.log(
    JSON.stringify({
      imported,
      quarantined: skipped,
      scope:
        "Only individually attributed user messages; original history retained",
    }),
  );
} finally {
  await pool.end();
}

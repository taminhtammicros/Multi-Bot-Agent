import "dotenv/config";
import assert from "node:assert/strict";
import { pool, query, migrate } from "../src/db.ts";
import { writeFile } from "node:fs/promises";
import { groupCompletion } from "../src/group-model.ts";
import { initSecrets } from "../src/security.ts";
import {
  recordGroupMessage,
  GroupBrainWorker,
  requestGroupSummary,
  groupBrainView,
  inGroup,
} from "../src/group-brain.ts";
if (!process.env.DATABASE_URL?.endsWith("/zalo_brain_test"))
  throw new Error("Synthetic test database only");
try {
  await initSecrets();
  await migrate();
  const s = { accountId: "123", groupId: "777777777" };
  await query("UPDATE settings SET value=$1 WHERE key='zalo'", [
    { groupsEnabled: true, allowGroups: [s.groupId], allowUsers: [] },
  ]);
  await inGroup(s, async (db, scope) => {
    await db.query(
      "INSERT INTO group_scopes(scope,account_id,group_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [scope, s.accountId, s.groupId],
    );
  });
  const messages = [
    ["An", "Thiết kế logo dự án Hoa: em đề xuất màu xanh lá."],
    [
      "Bình",
      "Máy chủ dự án Mây: bộ nhớ RAM đã đầy, em đề xuất nâng lên 16 GB.",
    ],
    [
      "Nam",
      "Về logo dự án Hoa, anh chốt màu xanh lá; An gửi bản vẽ ngày 06/11/2026.",
    ],
    ["An", "Em nhận làm logo, sẽ gửi ngày 06/11/2026."],
    [
      "Nam",
      "Máy chủ Mây chưa duyệt nâng RAM. Bình báo giá trước, thứ hai xem lại.",
    ],
    ["Bình", "Em sẽ gửi báo giá RAM máy chủ Mây trước 17h ngày 05/11/2026."],
  ];
  for (const [i, [senderName, content]] of messages.entries())
    await recordGroupMessage(s, {
      externalId: "synthetic-" + i,
      senderId: String(100 + i),
      senderName,
      content,
    });
  await requestGroupSummary(s);
  await new GroupBrainWorker(async (messages) => {
    const result = await groupCompletion(messages);
    await writeFile("/tmp/group-brain-synthetic-output.json", result.text, {
      mode: 0o600,
    });
    return result;
  }).process(s);
  const view = await groupBrainView(s);
  assert.equal(view.counts.pending, "0", view.job?.last_error || "Pending");
  assert.ok(view.topics.length >= 2);
  assert.ok(view.facts.length > 0);
  assert.ok(
    view.facts.every((f) => f.sources.length > 0 && f.status !== "confirmed"),
  );
  console.log(
    JSON.stringify({
      syntheticModelSmoke: "passed",
      topics: view.topics.length,
      facts: view.facts.length,
      overview: !!view.overview?.summary,
      noZaloMessagesSent: true,
    }),
  );
} finally {
  await pool.end();
}

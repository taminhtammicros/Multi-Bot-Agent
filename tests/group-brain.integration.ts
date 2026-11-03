import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pool, query, migrate } from "../src/db.js";
import { initSecrets, encrypt } from "../src/security.js";
import { groupCompletion } from "../src/group-model.js";
import {
  recordGroupMessage,
  inGroup,
  groupScope,
  groupContext,
  groupBrainView,
  GroupBrainWorker,
  requestGroupSummary,
  editGroupFact,
  reorganizeGroupTopic,
  reclassifyGroupRecord,
} from "../src/group-brain.js";
import { ZaloBridge } from "../src/zalo.js";
import { setReplyMode } from "../src/reply-policy.js";
import { saveChatProfile, defaultProfile } from "../src/chat-profiles.js";
import { enqueue, context, Engine } from "../src/engine.js";
if (!process.env.DATABASE_URL?.endsWith("/zalo_brain_test"))
  throw new Error("Use isolated /zalo_brain_test database only");
const A = { accountId: "111", groupId: "222" },
  B = { accountId: "111", groupId: "333" },
  C = { accountId: "999", groupId: "222" };
let server: ReturnType<typeof createServer>, baseUrl: string;
const requests: any[] = [];
before(async () => {
  await migrate();
  await initSecrets();
  await query("TRUNCATE group_scopes,conversations CASCADE");
  await query("UPDATE settings SET value=$1 WHERE key='zalo'", [
    { groupsEnabled: true, allowGroups: ["222", "333"], allowUsers: [] },
  ]);
  await query(
    "UPDATE agents SET enabled=true,health='online',base_url='http://127.0.0.1:1/v1',model='hermes' WHERE id='hermes'",
  );
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ headers: req.headers, body: JSON.parse(raw) });
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          { finish_reason: "stop", message: { content: "Trả lời riêng nhóm" } },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  await query(
    "INSERT INTO settings(key,value) VALUES('group_brain_model',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
    [
      {
        enabled: true,
        mode: "direct-stateless",
        baseUrl,
        model: "private-test",
        secret: encrypt("test"),
      },
    ],
  );
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});
const record = (s: any, text: string, id: string = randomUUID()) =>
  recordGroupMessage(s, {
    externalId: id,
    senderId: "555",
    senderName: "An",
    content: text,
  });

test("RLS blocks unfiltered reads, wrong account, wrong group, and cross-scope inserts/FKs", async () => {
  const a = await record(A, "SECRET_A"),
    b = await record(B, "SECRET_B");
  await record(C, "SECRET_C");
  await inGroup(A, async (db) => {
    const all = (await db.query("SELECT content FROM group_records")).rows.map(
      (r) => r.content,
    );
    assert.deepEqual(all, ["SECRET_A"]);
    assert.equal(
      (await db.query("SELECT * FROM group_records WHERE id=$1", [b])).rowCount,
      0,
    );
  });
  await assert.rejects(
    inGroup(A, async (db) => {
      await db.query(
        "INSERT INTO group_topics(scope,id,title) VALUES($1,$2,'bad')",
        [groupScope(B), randomUUID()],
      );
    }),
    /row-level security/,
  );
  const topic = randomUUID();
  await inGroup(A, async (db, scope) => {
    await db.query(
      "INSERT INTO group_topics(scope,id,title) VALUES($1,$2,'A')",
      [scope, topic],
    );
  });
  await assert.rejects(
    inGroup(A, async (db, scope) => {
      await db.query(
        "INSERT INTO group_record_topics(scope,record_id,topic_id) VALUES($1,$2,$3)",
        [scope, b, topic],
      );
    }),
    /foreign key/,
  );
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE zhub_group_scope");
    await db.query("SELECT set_config('zhub.group_scope','',true)");
    assert.equal((await db.query("SELECT * FROM group_records")).rowCount, 0);
    await db.query("ROLLBACK");
  } finally {
    db.release();
  }
  assert.equal(
    await inGroup(
      A,
      async (db) =>
        (await db.query("SELECT current_user AS name")).rows[0].name,
    ),
    "zhub_group_scope",
  );
  assert.notEqual(
    (await query("SELECT current_user AS name")).rows[0].name,
    "zhub_group_scope",
  );
  assert.ok(a);
});

test("listener stores untagged text without tasks; duplicate delivery, silent and other accounts are fenced", async () => {
  await setReplyMode(A.accountId, "group", A.groupId, "mention");
  const bridge = new ZaloBridge();
  bridge.status = "connected";
  bridge.api = { getOwnId: () => A.accountId } as any;
  const message = {
    type: 1,
    isSelf: false,
    threadId: A.groupId,
    data: {
      uidFrom: "555",
      dName: "An",
      msgId: "listen1",
      content: "Chốt giao thứ sáu",
      ts: Date.now(),
    },
  };
  const before = (await query("SELECT count(*)::int AS n FROM tasks")).rows[0]
    .n;
  await bridge.receive(message);
  await bridge.receive(message);
  assert.equal(
    (await query("SELECT count(*)::int AS n FROM tasks")).rows[0].n,
    before,
  );
  assert.equal(
    await inGroup(
      A,
      async (db, s) =>
        (
          await db.query(
            "SELECT count(*)::int AS n FROM group_records WHERE scope=$1 AND external_id='listen1'",
            [s],
          )
        ).rows[0].n,
    ),
    1,
  );
  await setReplyMode(A.accountId, "group", A.groupId, "silent");
  await bridge.receive({
    ...message,
    data: { ...message.data, msgId: "ignored" },
  });
  assert.equal(
    await inGroup(
      A,
      async (db, s) =>
        (
          await db.query(
            "SELECT 1 FROM group_records WHERE scope=$1 AND external_id='ignored'",
            [s],
          )
        ).rowCount,
    ),
    0,
  );
  await setReplyMode(A.accountId, "group", A.groupId, "mention");
  await saveChatProfile(A.accountId, "group", A.groupId, {
    ...defaultProfile(),
    groupMemoryEnabled: false,
  });
  await bridge.receive({
    ...message,
    data: { ...message.data, msgId: "disabled" },
  });
  assert.equal(
    await inGroup(
      A,
      async (db, s) =>
        (
          await db.query(
            "SELECT 1 FROM group_records WHERE scope=$1 AND external_id='disabled'",
            [s],
          )
        ).rowCount,
    ),
    0,
  );
  await saveChatProfile(A.accountId, "group", A.groupId, defaultProfile());
});

test("worker persists topic/fact with real evidence, retries malformed output without advancing, and resumes after lease expiry", async () => {
  // Clear only the isolated test's group A records to make the exact batch deterministic.
  await query("TRUNCATE group_scopes CASCADE");
  await record(A, "Chốt giao thứ sáu", "decision");
  await requestGroupSummary(A);
  const worker = new GroupBrainWorker(async (messages) => {
    const payload = JSON.parse(messages[1].content),
      r = payload.records[0];
    return {
      text: JSON.stringify({
        topics: [
          {
            key: "delivery",
            existingId: null,
            title: "Bàn giao",
            summary: "Mục tiêu: bàn giao. Cần xác minh người quyết định.",
            recordIds: [r.id],
            facts: [
              {
                category: "deadline",
                content: "Giao thứ sáu",
                evidence: [{ recordId: r.id, quote: r.content }],
                contradicts: [],
              },
            ],
          },
        ],
        noiseIds: [],
      }),
      incomplete: false,
      metrics: {
        requestBytes: 0,
        responseBytes: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    };
  });
  await Promise.all([worker.process(A), worker.process(A)]);
  let view = await groupBrainView(A);
  assert.equal(view.facts.length, 1);
  assert.equal(view.facts[0].status, "proposed");
  assert.equal(view.counts.pending, "0");
  assert.equal(view.facts[0].sources[0].content, "Chốt giao thứ sáu");
  const topic = view.topics[0].id;
  await editGroupFact(A, view.facts[0].id, "confirmed");
  await record(A, "Đề xuất dời thứ hai", "proposal");
  await requestGroupSummary(A);
  const badWorker = new GroupBrainWorker(async () => ({
    text: '{"topics":[],"noiseIds":[]}',
    incomplete: false,
    metrics: {
      requestBytes: 0,
      responseBytes: 0,
      inputTokens: 0,
      outputTokens: 0,
    },
  }));
  await badWorker.process(A);
  view = await groupBrainView(A);
  assert.equal(view.counts.pending, "1");
  assert.ok(view.job.last_error);
  assert.equal(view.facts[0].status, "confirmed");
  await inGroup(A, async (db, s) => {
    await db.query(
      "UPDATE group_brain_jobs SET lease=$2,lease_until=now()-interval '1 minute',next_run_at=now() WHERE scope=$1",
      [s, randomUUID()],
    );
  });
  const continuation = new GroupBrainWorker(async (messages) => {
    const p = JSON.parse(messages[1].content),
      r = p.records[0];
    return {
      text: JSON.stringify({
        topics: [
          {
            key: "delivery",
            existingId: topic,
            title: "Bàn giao",
            summary: "Deadline cũ và đề xuất thay đổi chưa chốt.",
            recordIds: [r.id],
            facts: [
              {
                category: "deadline",
                content: "Đề xuất thứ hai",
                evidence: [{ recordId: r.id, quote: r.content }],
                contradicts: [view.facts[0].id],
              },
            ],
          },
        ],
        noiseIds: [],
      }),
      incomplete: false,
      metrics: {
        requestBytes: 0,
        responseBytes: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    };
  });
  await continuation.process(A);
  view = await groupBrainView(A);
  assert.equal(view.topics.length, 1);
  assert.equal(view.facts.length, 2);
  assert.equal(
    view.facts.find((f) => f.content === "Đề xuất thứ hai").status,
    "disputed",
  );
  assert.equal(
    view.facts.find((f) => f.content === "Giao thứ sáu").status,
    "confirmed",
  );
  assert.equal(view.counts.pending, "0");
});

test("topic merge/split, fact replacement and classification corrections stay scoped and auditable", async () => {
  let view = await groupBrainView(A);
  const old = view.facts.find((f) => f.status === "confirmed"),
    proposal = view.facts.find((f) => f.status === "disputed");
  await editGroupFact(A, proposal.id, "confirmed", old.id);
  view = await groupBrainView(A);
  assert.ok(view.facts.find((f) => f.id === old.id).valid_to);
  await assert.rejects(editGroupFact(B, proposal.id, "confirmed"));
  const source = proposal.sources[0].id;
  const split = await reorganizeGroupTopic(A, proposal.topic_id, {
    title: "Đề xuất mới",
    recordIds: [source],
  });
  assert.equal((await groupBrainView(A)).topics.length, 2);
  await assert.rejects(
    reorganizeGroupTopic(B, proposal.topic_id, { targetId: split.topicId }),
  );
  await reorganizeGroupTopic(A, split.topicId, { targetId: proposal.topic_id });
  assert.equal((await groupBrainView(A)).topics.length, 1);
  await reclassifyGroupRecord(A, source, false);
  await assert.rejects(reclassifyGroupRecord(B, source, false));
});

test("context retrieves older evidence and never mixes groups/accounts; model requests have no tools or session", async () => {
  await record(B, "MARKER_GROUP_B");
  await record(C, "MARKER_ACCOUNT_C");
  for (let i = 0; i < 65; i++) await record(A, "Tin gần đây " + i);
  const content = await groupContext(A, "deadline bàn giao");
  assert.match(content, /Đề xuất dời thứ hai/);
  assert.doesNotMatch(content, /MARKER_GROUP_B|MARKER_ACCOUNT_C/);
  await groupCompletion([
    { role: "system", content },
    { role: "user", content: "Deadline?" },
  ]);
  const sent = requests.at(-1);
  assert.equal(sent.body.store, false);
  assert.equal(sent.body.tools, undefined);
  assert.equal(sent.headers["x-hermes-session-id"], undefined);
  assert.equal(sent.headers["x-openclaw-agent-id"], undefined);
  await query(
    "UPDATE settings SET value=jsonb_set(value,'{enabled}','false') WHERE key='group_brain_model'",
  );
  const count = requests.length;
  await assert.rejects(groupCompletion([{ role: "user", content: "secret" }]));
  assert.equal(requests.length, count);
  await query(
    "UPDATE settings SET value=jsonb_set(value,'{enabled}','true') WHERE key='group_brain_model'",
  );
});

test("group engine uses canonical scope, rejects legacy transcript and cannot delegate to shared agents", async () => {
  await setReplyMode(A.accountId, "group", A.groupId, "all");
  await record(A, "Hãy giao OpenClaw phân tích nhóm này", "engine");
  const task = await enqueue(
    "old-id",
    "A",
    "zalo",
    "Hãy giao OpenClaw phân tích nhóm này",
    "engine-task",
    A.groupId,
    1,
    {
      sourceAccountId: A.accountId,
      zaloReply: { senderId: "555", senderName: "An" },
    },
  );
  const row = (await query("SELECT * FROM tasks WHERE id=$1", [task])).rows[0];
  assert.equal(row.conversation_id, groupScope(A));
  const ctx = await context(row.conversation_id, row.message_id);
  assert.doesNotMatch(JSON.stringify(ctx), /MARKER_GROUP_B|MARKER_ACCOUNT_C/);
  const before = requests.length;
  await new Engine().tick();
  assert.equal(requests.length, before + 1);
  assert.equal(
    (await query("SELECT status FROM tasks WHERE id=$1", [task])).rows[0]
      .status,
    "completed",
  );
  assert.equal(
    (
      await query(
        "SELECT count(*)::int AS n FROM tasks WHERE parent_id IS NOT NULL",
      )
    ).rows[0].n,
    0,
  );
  await assert.rejects(
    enqueue("legacy", "A", "zalo", "bad", undefined, A.groupId, 1, {}),
  );
});

test("worker accounts for interleaved topics, multi-topic messages and an exact reply source", async () => {
  const D = { accountId: "111", groupId: "444" };
  await query(
    "UPDATE settings SET value=jsonb_set(value,'{allowGroups}',value->'allowGroups'||'[\"444\"]'::jsonb) WHERE key='zalo'",
  );
  await record(D, "Thiết kế logo màu xanh", "logo");
  await record(D, "Server cần nâng RAM", "server");
  await recordGroupMessage(D, {
    externalId: "both",
    senderId: "555",
    senderName: "An",
    content: "Chốt cả hai",
    replyExternalId: "logo",
    replyExcerpt: "Thiết kế logo màu xanh",
  });
  await requestGroupSummary(D);
  const worker = new GroupBrainWorker(async (messages) => {
    const p = JSON.parse(messages[1].content),
      [a, b, c] = p.records;
    return {
      text: JSON.stringify({
        overview:
          "Nhóm đang xử lý thiết kế và hạ tầng; cần xác nhận người phụ trách.",
        topics: [
          {
            key: "logo",
            existingId: null,
            title: "Thiết kế",
            summary: "Logo màu xanh",
            recordIds: [a.id, c.id],
            facts: [],
          },
          {
            key: "server",
            existingId: null,
            title: "Hạ tầng",
            summary: "Nâng RAM",
            recordIds: [b.id, c.id],
            facts: [],
          },
        ],
        noiseIds: [],
      }),
      incomplete: false,
      metrics: {
        requestBytes: 0,
        responseBytes: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    };
  });
  await worker.process(D);
  let view = await groupBrainView(D);
  assert.equal(view.topics.length, 2);
  assert.ok(view.overview.summary);
  const both = view.records.find((r) => r.content === "Chốt cả hai");
  assert.equal(
    await inGroup(
      D,
      async (db, s) =>
        (
          await db.query(
            "SELECT count(*)::int AS n FROM group_record_topics WHERE scope=$1 AND record_id=$2",
            [s, both.id],
          )
        ).rows[0].n,
    ),
    2,
  );
  await inGroup(D, async (db, s) => {
    await db.query(
      "UPDATE group_brain_jobs SET last_full_rebuild_at=now()-interval '8 days',next_run_at=now() WHERE scope=$1",
      [s],
    );
  });
  const rebuilt = new GroupBrainWorker(async (messages) => {
    const p = JSON.parse(messages[1].content);
    assert.ok(p.topics.every((t: any) => t.summary === ""));
    const t = p.topics.find((t: any) => t.title === "Thiết kế");
    return {
      text: JSON.stringify({
        overview: "Tổng hợp lại từ nguồn.",
        topics: [
          {
            key: "one",
            existingId: t.id,
            title: t.title,
            summary: "Đã đọc lại nguồn gốc",
            recordIds: p.records.map((r: any) => r.id),
            facts: [],
          },
        ],
        noiseIds: [],
      }),
      incomplete: false,
      metrics: {
        requestBytes: 0,
        responseBytes: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    };
  });
  await rebuilt.process(D);
  view = await groupBrainView(D);
  assert.equal(view.counts.pending, "0");
  assert.equal(view.overview.revision, 2);
});

test("revocation during inference prevents a memory commit and keeps pending sources", async () => {
  const E = { accountId: "111", groupId: "666" };
  await setReplyMode(E.accountId, "group", E.groupId, "mention");
  await record(E, "Deadline cần xác minh", "pending");
  await requestGroupSummary(E);
  const worker = new GroupBrainWorker(async (messages) => {
    const p = JSON.parse(messages[1].content),
      r = p.records[0];
    await setReplyMode(E.accountId, "group", E.groupId, "silent");
    return {
      text: JSON.stringify({
        topics: [
          {
            key: "t",
            existingId: null,
            title: "T",
            summary: "S",
            recordIds: [r.id],
            facts: [],
          },
        ],
        noiseIds: [],
      }),
      incomplete: false,
      metrics: {
        requestBytes: 0,
        responseBytes: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    };
  });
  await worker.process(E);
  const view = await groupBrainView(E);
  assert.equal(view.topics.length, 0);
  assert.equal(view.counts.pending, "1");
});

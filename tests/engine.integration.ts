import {
  setReplyMode,
  replyMode,
  replaceZaloPolicy,
} from "../src/reply-policy.js";
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { query, migrate, pool } from "../src/db.js";
import { initSecrets, encrypt } from "../src/security.js";
import { enqueue, Engine, recover, context } from "../src/engine.js";
import {
  observeContact,
  listContacts,
  setContactAccess,
  observeGroup,
  setGroupAccess,
  setGroupsEnabled,
} from "../src/contacts.js";
import { ZaloBridge } from "../src/zalo.js";
import { UserMessage, GroupMessage } from "zca-js";
import {
  defaultProfile,
  saveChatProfile,
  getChatProfile,
} from "../src/chat-profiles.js";
import {
  addSource,
  knowledgeContext,
  sourceList,
  removeSource,
} from "../src/knowledge.js";
import { checkAgent, reconcile } from "../src/agents.js";
import { callAgent } from "../src/agents.js";
// Dedicated disposable database: never run against a configured user database.
if (!process.env.DATABASE_URL?.endsWith("/zalo_hub_test"))
  throw new Error("Use DATABASE_URL ending in /zalo_hub_test");
let server: any, url: string;
const seen: any[] = [];
let down = false,
  mode = "answer";
let releaseResponse: (() => void) | undefined;
let summaryToolsEnabled = false;
before(async () => {
  await migrate();
  await initSecrets();
  server = createServer(async (req, res) => {
    if (down) {
      res.writeHead(503);
      res.end("{}");
      return;
    }
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "mock" }] }));
      return;
    }
    if (req.url === "/v1/toolsets") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: [{ name: "terminal", enabled: summaryToolsEnabled }],
        }),
      );
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw);
    seen.push(data);
    if (mode === "synth-error" && data.model === "hermes") {
      res.writeHead(503);
      res.end("{}");
      return;
    }
    if (data.messages.at(-1)?.content === "hold")
      await new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
    if (mode === "hermes-error") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ finish_reason: "error", message: { content: "" } }],
          hermes: {
            failed: true,
            error:
              "HTTP 503: [403] Please subscribe to model in the API Key; PRIVATE_DIAGNOSTIC_TOKEN",
          },
        }),
      );
      return;
    }
    res.setHeader("Content-Type", "application/json");
    const delegate =
      ["delegate", "delegate-empty"].includes(mode) &&
      data.model === "hermes" &&
      !data.messages[0]?.content.includes("Hermes tổng hợp cuối") &&
      !data.messages.some((x: any) => x.content.includes("Kết quả OpenClaw"));
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content:
                mode === "delegate-empty" && data.model === "openclaw"
                  ? "No response from OpenClaw."
                  : delegate
                    ? JSON.stringify({
                        action: "delegate_openclaw",
                        task: "Verify files and report",
                      })
                    : `Answer from ${data.model}`,
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}/v1`;
});
after(async () => {
  server?.close();
  await pool.end();
});
test("profiles and knowledge remain isolated by account, kind and UID and reload after edits", async () => {
  await reset();
  const p = { ...defaultProfile(), personality: "Xưng em trong nhóm A" };
  await saveChatProfile("111", "group", "222", p);
  assert.equal(
    (await getChatProfile("111", "group", "222")).personality,
    p.personality,
  );
  for (const [account, kind, uid] of [
    ["111", "dm", "222"],
    ["333", "group", "222"],
    ["111", "group", "444"],
  ])
    assert.equal((await getChatProfile(account, kind, uid)).personality, "");
  await saveChatProfile("111", "group", "222", {
    ...p,
    personality: "Xưng tôi",
  });
  assert.equal(
    (await getChatProfile("111", "group", "222")).personality,
    "Xưng tôi",
  );
  const source = await addSource("111", "group", "222", {
    type: "note",
    name: "Quy định A",
    content: "Mã bảo hành riêng của nhóm là WARRANTY_A_77.",
  });
  assert.match(
    await knowledgeContext("111", "group", "222", "Mã bảo hành?"),
    /WARRANTY_A_77/,
  );
  assert.equal(await knowledgeContext("111", "dm", "222", "Mã bảo hành?"), "");
  await removeSource("111", "dm", "222", source.id);
  assert.equal((await sourceList("111", "group", "222")).length, 1);
  await removeSource("111", "group", "222", source.id);
  assert.equal((await sourceList("111", "group", "222")).length, 0);
});
test("group welcomes send native mentions once and stop when permissions are revoked", async () => {
  await reset();
  const account = "111",
    group = "222";
  await query("UPDATE settings SET value=$1 WHERE key='zalo'", [
    { allowUsers: [], allowGroups: [], groupsEnabled: true },
  ]);
  await setReplyMode(account, "group", group, "mention");
  await saveChatProfile(account, "group", group, {
    ...defaultProfile(),
    welcome: "Chào {members}, mừng đến {group}!",
  });
  const sent: any[] = [];
  const bridge = new ZaloBridge();
  bridge.status = "connected";
  bridge.api = {
    getOwnId: () => account,
    sendMessage: async (...args: any[]) => sent.push(args),
  } as any;
  const evt = {
    type: "join",
    threadId: group,
    data: {
      groupId: group,
      time: 123,
      groupName: "Nhóm thử",
      updateMembers: [
        { id: "333", dName: "An" },
        { id: account, dName: "Bot" },
      ],
    },
  };
  await bridge.queueWelcome(evt, bridge.api!);
  await bridge.queueWelcome(evt, bridge.api!);
  await bridge.flushAnnouncements();
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0].msg, "Chào @An, mừng đến Nhóm thử!");
  assert.deepEqual(sent[0][0].mentions, [{ uid: "333", pos: 5, len: 3 }]);
  await bridge.queueWelcome(
    { ...evt, data: { ...evt.data, time: 124 } },
    bridge.api!,
  );
  await setReplyMode(account, "group", group, "silent");
  await bridge.flushAnnouncements();
  assert.equal(sent.length, 1);
  assert.equal(
    (
      await query(
        "SELECT status FROM zalo_announcements WHERE status='cancelled'",
      )
    ).rowCount,
    1,
  );
});
async function reset() {
  down = false;
  mode = "answer";
  seen.length = 0;
  summaryToolsEnabled = false;
  await query(
    "INSERT INTO settings(key,value) VALUES('hermes_synthesis',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
    [
      {
        enabled: true,
        baseUrl: url,
        model: "hermes",
        secret: encrypt("test-key"),
      },
    ],
  );
  await query(
    "INSERT INTO settings(key,value) VALUES('group_brain_model',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
    [
      {
        enabled: true,
        mode: "direct-stateless",
        baseUrl: url,
        model: "private-group",
        secret: encrypt("test-key"),
      },
    ],
  );
  await query(
    "TRUNCATE group_scopes,outbox,runs,tasks,messages,memories,conversations,events,zalo_contacts,zalo_groups,zalo_reply_rules,chat_profiles,chat_sources,zalo_announcements CASCADE",
  );
  await query(
    "UPDATE agents SET enabled=false,health='unconfigured',failures=0,run_failures=0,last_run_error=null,last_run_ms=null,last_run_at=null,healthy_since=null,run_cooldown_until=null",
  );
  await query(
    "UPDATE settings SET value='{" +
      '"preferred":"auto","failureThreshold":1,"recoverySeconds":10,"paused":false' +
      "}'::jsonb WHERE key='routing'",
  );
  await query(
    "UPDATE leadership SET agent=null,generation=0,changed_at=now() WHERE id=1",
  );
}
async function connect(id: string) {
  await query(
    "UPDATE agents SET enabled=true,base_url=$2,model=$1,secret=$3 WHERE id=$1",
    [id, url, encrypt("test-key")],
  );
  await checkAgent(id);
  await reconcile();
}
test("per-chat model and reasoning reach the selected agent; backup retains its configured model", async () => {
  await reset();
  await connect("hermes");
  await connect("openclaw");
  const profile = {
    ...defaultProfile(),
    brain: "hermes" as const,
    model: "custom-model-A",
    provider: "custom",
    quality: "long" as const,
  };
  const messages = [
    { role: "system", content: "Profile test" },
    { role: "user", content: "hello" },
  ];
  await callAgent("hermes", messages, randomUUID(), {
    profile,
    accountId: "111",
    kind: "dm",
    uid: "222",
  });
  assert.equal(seen.at(-1).model, "custom-model-A");
  assert.equal(seen.at(-1).provider, "custom");
  assert.equal(seen.at(-1).model_options.reasoning_effort, "high");
  await callAgent("openclaw", messages, randomUUID(), {
    profile,
    accountId: "111",
    kind: "dm",
    uid: "222",
  });
  assert.equal(seen.at(-1).model, "openclaw");
  await assert.rejects(
    callAgent("openclaw", messages, randomUUID(), {
      profile: { ...profile, systemCommands: false },
      accountId: "111",
      kind: "dm",
      uid: "222",
    }),
    /guard/,
  );
});
test("Zalo turns reload scoped personality and knowledge into shared history", async () => {
  await reset();
  await connect("hermes");
  const account = "111",
    group = "222";
  await query("UPDATE settings SET value=$1 WHERE key='zalo'", [
    { allowUsers: [], allowGroups: [], groupsEnabled: true },
  ]);
  await setReplyMode(account, "group", group, "all");
  await saveChatProfile(account, "group", group, {
    ...defaultProfile(),
    personality: "Xưng em, gọi nhóm là anh chị. PERSONA_A",
  });
  await addSource(account, "group", group, {
    type: "note",
    name: "Chính sách nhóm",
    content: "Mã bảo hành GROUP_A_WARRANTY.",
  });
  const bridge = new ZaloBridge();
  bridge.status = "connected";
  bridge.api = { getOwnId: () => account, sendMessage: async () => {} } as any;
  const receive = async (id: string, content: string) =>
    bridge.receive(
      new GroupMessage(account, {
        uidFrom: "333",
        idTo: group,
        msgId: id,
        content,
        dName: "An",
      } as any),
    );
  await receive("profile-turn-1", "Mã bảo hành của nhóm?");
  await new Engine().tick();
  assert.match(seen.at(-1).messages[0].content, /PERSONA_A/);
  assert.match(seen.at(-1).messages[0].content, /GROUP_A_WARRANTY/);
  await bridge.flush();
  await saveChatProfile(account, "group", group, {
    ...defaultProfile(),
    personality: "Xưng tôi. PERSONA_UPDATED",
  });
  await receive("profile-turn-2", "Nhắc lại yêu cầu trước đó");
  await new Engine().tick();
  assert.match(seen.at(-1).messages[0].content, /PERSONA_UPDATED/);
  assert.doesNotMatch(seen.at(-1).messages[0].content, /PERSONA_A\b/);
  assert.match(seen.at(-1).messages[0].content, /Mã bảo hành của nhóm\?/);
});
test("only an exact allow-listed Zalo sender receives Bot Owner instructions", async () => {
  await reset();
  const account = "111",
    group = "222";
  await query("UPDATE settings SET value=$1 WHERE key='zalo'", [
    { allowUsers: ["444"], allowGroups: [group], groupsEnabled: true },
  ]);
  const ownerConversation = "owner-test";
  const ownerTask = await enqueue(
    ownerConversation,
    "Owner test",
    "zalo",
    "Hãy kiểm tra trạng thái",
    undefined,
    group,
    0,
    {
      sourceAccountId: account,
      zaloReply: { senderId: "444", senderName: "Owner" },
    },
  );
  const ownerMessage = (
    await query("SELECT message_id FROM tasks WHERE id=$1", [ownerTask])
  ).rows[0].message_id;
  assert.match(
    (await context(ownerConversation, ownerMessage))[0].content,
    /BOT OWNER ĐÃ XÁC THỰC/,
  );
  const guestConversation = "guest-test";
  const guestTask = await enqueue(
    guestConversation,
    "Guest test",
    "zalo",
    "Hãy kiểm tra trạng thái",
    undefined,
    group,
    0,
    {
      sourceAccountId: account,
      zaloReply: { senderId: "555", senderName: "Guest" },
    },
  );
  const guestMessage = (
    await query("SELECT message_id FROM tasks WHERE id=$1", [guestTask])
  ).rows[0].message_id;
  assert.doesNotMatch(
    (await context(guestConversation, guestMessage))[0].content,
    /BOT OWNER ĐÃ XÁC THỰC/,
  );
});
test("single OpenClaw Main, durable duplicate suppression and shared context", async () => {
  await reset();
  await connect("openclaw");
  const id = randomUUID();
  const task = await enqueue(
    id,
    "test",
    "dashboard",
    "My preference is PostgreSQL",
    "external-test",
  );
  assert.ok(task);
  assert.equal(
    await enqueue(id, "test", "dashboard", "duplicate", "external-test"),
    null,
  );
  const engine = new Engine();
  await engine.tick();
  assert.equal(
    (await query("SELECT status FROM tasks WHERE id=$1", [task])).rows[0]
      .status,
    "completed",
  );
  await query(
    "INSERT INTO memories(id,conversation_id,content) VALUES($1,$2,'User prefers concise answers')",
    [randomUUID(), id],
  );
  await connect("hermes");
  await query(
    "UPDATE agents SET healthy_since=now()-interval '1 minute' WHERE id='hermes'",
  );
  await enqueue(id, "test", "dashboard", "Continue previous work");
  await engine.tick();
  const last = seen.at(-1);
  assert.equal(last.model, "hermes");
  assert.ok(
    last.messages.some((m: any) => m.content === "My preference is PostgreSQL"),
  );
  assert.ok(last.messages[0].content.includes("User prefers concise answers"));
});
test("sequential group replies wait for delivery and persist the exact question/asker for each turn", async () => {
  await reset();
  await connect("hermes");
  const account = "111",
    group = "222";
  await query("UPDATE settings SET value=$1 WHERE key='zalo'", [
    { allowUsers: [], allowGroups: [], groupsEnabled: true },
  ]);
  await setReplyMode(account, "group", group, "all");
  await saveChatProfile(account, "group", group, {
    ...defaultProfile(),
    sequentialReplies: true,
    replyTarget: "both",
  });
  const sends: any[] = [];
  const api = {
    getOwnId: () => account,
    sendMessage: async (...args: any[]) => sends.push(args),
  } as any;
  const bridge = new ZaloBridge();
  bridge.api = api;
  bridge.status = "connected";
  for (const [id, sender, name] of [
    ["1001", "333", "An"],
    ["1002", "444", "Bình"],
  ])
    await bridge.receive(
      new GroupMessage(account, {
        uidFrom: sender,
        idTo: group,
        msgId: id,
        cliMsgId: id + "11",
        ts: "1793512345679",
        content: "Cùng câu hỏi",
        dName: name,
      } as any),
    );
  const engine = new Engine();
  await engine.tick();
  await engine.tick();
  assert.equal(seen.length, 1);
  assert.equal(
    (await query("SELECT count(*)::int n FROM tasks WHERE status='queued'"))
      .rows[0].n,
    1,
  );
  // A new bridge instance demonstrates that reply metadata survives in the DB.
  const restored = new ZaloBridge();
  restored.api = api;
  restored.status = "connected";
  await restored.flush();
  await engine.tick();
  await restored.flush();
  assert.equal(sends.length, 2);
  assert.deepEqual(
    sends.map((x) => [
      x[0].quote.msgId,
      x[0].quote.uidFrom,
      x[0].mentions[0].uid,
      x[1],
    ]),
    [
      ["1001", "333", "333", group],
      ["1002", "444", "444", group],
    ],
  );
  assert.ok(sends.every((x) => x[0].quote.content === "Cùng câu hỏi"));
  assert.match(seen.at(-1).messages[0].content, /Bình/);
});
test("sequence off allows concurrent questions in one group while each result quotes its own original", async () => {
  await reset();
  await connect("hermes");
  const account = "111",
    group = "222";
  await query("UPDATE settings SET value=$1 WHERE key='zalo'", [
    { allowUsers: [], allowGroups: [], groupsEnabled: true },
  ]);
  await setReplyMode(account, "group", group, "all");
  await saveChatProfile(account, "group", group, {
    ...defaultProfile(),
    sequentialReplies: false,
    replyTarget: "reply",
  });
  const sends: any[] = [];
  const bridge = new ZaloBridge();
  bridge.status = "connected";
  bridge.api = {
    getOwnId: () => account,
    sendMessage: async (...args: any[]) => sends.push(args),
  } as any;
  for (const [id, sender, content] of [
    ["2001", "333", "hold"],
    ["2002", "444", "Fast answer"],
  ])
    await bridge.receive(
      new GroupMessage(account, {
        uidFrom: sender,
        idTo: group,
        msgId: id,
        cliMsgId: id + "11",
        ts: "1793512345679",
        content,
        dName: sender,
      } as any),
    );
  const engine = new Engine(),
    slow = engine.tick();
  try {
    for (let i = 0; !releaseResponse && i < 200; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(releaseResponse);
    await engine.tick();
    await bridge.flush();
    assert.equal(sends.length, 1);
    assert.equal(sends[0][0].quote.msgId, "2002");
    assert.equal(sends[0][0].quote.uidFrom, "444");
  } finally {
    releaseResponse?.();
    releaseResponse = undefined;
    await slow;
  }
  await bridge.flush();
  assert.equal(sends.length, 2);
  assert.equal(sends[1][0].quote.msgId, "2001");
  assert.equal(sends[1][0].quote.uidFrom, "333");
});
test("health downtime switches Hermes to OpenClaw", async () => {
  await reset();
  await connect("hermes");
  await connect("openclaw");
  assert.equal((await reconcile()).agent, "hermes");
  await query(
    "UPDATE agents SET base_url='http://127.0.0.1:1/v1' WHERE id='hermes'",
  );
  await checkAgent("hermes");
  assert.equal((await reconcile()).agent, "openclaw");
});
test("delegated result returns to Hermes; child and parent persisted", async () => {
  await reset();
  await connect("hermes");
  await connect("openclaw");
  mode = "delegate";
  const id = randomUUID();
  await enqueue(id, "delegation", "dashboard", "Inspect project files");
  await new Engine().tick();
  assert.deepEqual(
    seen.map((x) => x.model),
    ["hermes", "openclaw", "hermes"],
  );
  const rows = (await query("SELECT status,parent_id FROM tasks")).rows;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.status === "completed"));
  assert.equal(
    (await query("SELECT count(*)::int AS n FROM outbox")).rows[0].n,
    1,
  );
  assert.match(seen[1].messages[0].content, /worker nhận việc từ Hermes/);
  assert.doesNotMatch(
    seen[1].messages[0].content,
    /có thể yêu cầu dịch vụ giao việc/,
  );
  assert.match(seen[2].messages[0].content, /Hermes tổng hợp cuối/);
  assert.equal(seen[2].model_options.reasoning_effort, "low");
  const evidence = JSON.parse(seen[2].messages.at(-1).content);
  assert.equal(evidence.evidence, "Answer from openclaw");
  assert.deepEqual(
    (await query("SELECT phase FROM runs ORDER BY created_at")).rows.map(
      (r) => r.phase,
    ),
    ["main", "delegate", "synthesis"],
  );
});
test("OpenClaw supporter can be disabled per chat; Hermes handles the request itself", async () => {
  await reset();
  await connect("hermes");
  await connect("openclaw");
  await saveChatProfile("111", "dm", "222", {
    ...defaultProfile(),
    openClawSupport: false,
  });
  await enqueue(
    randomUUID(),
    "support-off",
    "dashboard",
    "Tìm hiểu chủ đề này",
    undefined,
    "222",
    0,
    { sourceAccountId: "111" },
  );
  await new Engine().tick();
  assert.deepEqual(
    seen.map((x) => x.model),
    ["hermes"],
  );
  assert.match(seen[0].messages[0].content, /supporter hiện tắt/);
  assert.equal(
    (
      await query(
        "SELECT count(*)::int AS n FROM tasks WHERE parent_id IS NOT NULL",
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (await query("SELECT agent FROM tasks WHERE parent_id IS NULL")).rows[0]
      .agent,
    "hermes",
  );
});
test("enabled supporter dispatches research questions even if Hermes answers instead of returning a handoff", async () => {
  await reset();
  await connect("hermes");
  await connect("openclaw");
  await saveChatProfile("111", "dm", "222", {
    ...defaultProfile(),
    openClawSupport: true,
  });
  await enqueue(
    randomUUID(),
    "support-required",
    "dashboard",
    "phân tích cổ phiếu VIC",
    undefined,
    "222",
    0,
    { sourceAccountId: "111" },
  );
  await new Engine().tick();
  assert.deepEqual(
    seen.map((x) => x.model),
    ["hermes", "openclaw", "hermes"],
  );
  assert.match(seen[0].messages[0].content, /VAI TRÒ ĐIỀU PHỐI BẮT BUỘC/);
  assert.match(seen[1].messages.at(-1).content, /phân tích cổ phiếu VIC/);
  assert.match(seen[1].messages.at(-1).content, /Phân tích sơ bộ của Hermes/);
  assert.deepEqual(
    (await query("SELECT phase FROM runs ORDER BY created_at")).rows.map(
      (r) => r.phase,
    ),
    ["main", "delegate", "synthesis"],
  );
});
test("fast synthesis refuses a tool-enabled endpoint and preserves worker evidence instead of re-researching", async () => {
  await reset();
  await connect("hermes");
  await connect("openclaw");
  summaryToolsEnabled = true;
  await enqueue(
    randomUUID(),
    "tools gate",
    "dashboard",
    "Hãy giao việc cho OpenClaw",
  );
  await new Engine().tick();
  assert.deepEqual(
    seen.map((x) => x.model),
    ["openclaw"],
  );
  const parent = (await query("SELECT * FROM tasks WHERE parent_id IS NULL"))
    .rows[0];
  assert.equal(parent.status, "review");
  assert.match(parent.result, /Answer from openclaw/);
  assert.equal(
    (await query("SELECT health FROM agents WHERE id='hermes'")).rows[0].health,
    "online",
  );
});
test("verify synthesis remains opt-in and keeps the normal Hermes endpoint, full context and requested depth", async () => {
  await reset();
  await connect("hermes");
  await connect("openclaw");
  summaryToolsEnabled = true;
  await saveChatProfile("111", "dm", "222", {
    ...defaultProfile(),
    handoffSynthesis: "verify",
    quality: "long",
  });
  await enqueue(
    randomUUID(),
    "verify",
    "dashboard",
    "Hãy giao việc cho OpenClaw",
    "verify-run",
    "222",
    0,
    { sourceAccountId: "111" },
  );
  await new Engine().tick();
  assert.deepEqual(
    seen.map((x) => x.model),
    ["openclaw", "hermes"],
  );
  assert.doesNotMatch(seen[1].messages[0].content, /Hermes tổng hợp cuối/);
  assert.match(seen[1].messages.at(-1).content, /Kết quả OpenClaw/);
  assert.equal(seen[1].model_options.reasoning_effort, "high");
  assert.equal(
    (await query("SELECT status FROM tasks WHERE parent_id IS NULL")).rows[0]
      .status,
    "completed",
  );
});
test("OpenClaw empty transport fallback is not success and its failure returns to Hermes without replay", async () => {
  await reset();
  await connect("hermes");
  await connect("openclaw");
  mode = "delegate-empty";
  await enqueue(
    randomUUID(),
    "delegation",
    "dashboard",
    "Hãy giao việc cho OpenClaw, hiển thị chi tiết cách giao việc",
  );
  const engine = new Engine();
  await engine.tick();
  assert.deepEqual(
    seen.map((x) => x.model),
    ["openclaw", "hermes"],
  );
  const child = (await query("SELECT * FROM tasks WHERE parent_id IS NOT NULL"))
    .rows[0];
  const parent = (await query("SELECT * FROM tasks WHERE parent_id IS NULL"))
    .rows[0];
  assert.equal(child.status, "review");
  assert.equal(child.result, null);
  assert.match(child.error, /chưa trả kết quả xác thực/);
  assert.equal(parent.status, "review");
  assert.match(parent.result, /Chi tiết giao việc/);
  assert.match(parent.result, /chưa có kết quả hoàn tất/);
  assert.match(seen[1].messages.at(-1).content, /CHƯA CÓ KẾT QUẢ XÁC THỰC/);
  assert.equal(
    (await query("SELECT status FROM runs WHERE agent='openclaw'")).rows[0]
      .status,
    "unknown",
  );
  await engine.tick();
  assert.equal(seen.length, 2);
});
test("explicit OpenClaw routing dispatches a real child and preserves its result when Hermes synthesis fails", async () => {
  await reset();
  await connect("hermes");
  await connect("openclaw");
  mode = "synth-error";
  await enqueue(
    randomUUID(),
    "delegation",
    "dashboard",
    "Kiểm tra nguồn và giao việc cho Openclaw nhé, hiển thị chi tiết cách giao việc",
  );
  await new Engine().tick();
  assert.deepEqual(
    seen.map((x) => x.model),
    ["openclaw", "hermes"],
  );
  const child = (await query("SELECT * FROM tasks WHERE parent_id IS NOT NULL"))
      .rows[0],
    parent = (await query("SELECT * FROM tasks WHERE parent_id IS NULL"))
      .rows[0];
  assert.equal(child.status, "completed");
  assert.equal(parent.status, "review");
  assert.match(parent.result, /Answer from openclaw/);
  assert.match(parent.result, /Hermes chưa tổng hợp được/);
  assert.match(parent.result, /Hub → OpenClaw/);
  assert.equal(
    (await query("SELECT content FROM outbox")).rows[0].content,
    parent.result,
  );
});
test("ambiguous HTTP error becomes review and is not replayed", async () => {
  await reset();
  await connect("hermes");
  down = true;
  await enqueue(randomUUID(), "unknown", "dashboard", "Execute task");
  const engine = new Engine();
  await engine.tick();
  assert.equal(
    (await query("SELECT status FROM tasks")).rows[0].status,
    "review",
  );
  down = false;
  await engine.tick();
  assert.equal(
    (await query("SELECT count(*)::int AS n FROM runs")).rows[0].n,
    1,
  );
});
test("explicit delegation with an unavailable OpenClaw reports no dispatch rather than claiming a background job", async () => {
  await reset();
  await connect("hermes");
  await enqueue(
    randomUUID(),
    "delegation",
    "dashboard",
    "Hãy giao việc cho OpenClaw tra nguồn",
  );
  await new Engine().tick();
  assert.equal(seen.length, 0);
  const parent = (await query("SELECT * FROM tasks")).rows[0];
  assert.equal(parent.status, "review");
  assert.match(parent.result, /Chưa giao việc/);
  assert.equal((await query("SELECT count(*)::int n FROM runs")).rows[0].n, 0);
});
test("a reviewed turn does not freeze new questions in the same chat or replay the old action", async () => {
  await reset();
  await connect("hermes");
  const conv = randomUUID();
  const old = await enqueue(conv, "review", "dashboard", "Old request");
  await query(
    "UPDATE tasks SET status='review',error='Unknown action outcome' WHERE id=$1",
    [old],
  );
  const next = await enqueue(
    conv,
    "review",
    "dashboard",
    "New independent question",
  );
  await new Engine().tick();
  assert.equal(
    (await query("SELECT status FROM tasks WHERE id=$1", [old])).rows[0].status,
    "review",
  );
  assert.equal(
    (await query("SELECT status FROM tasks WHERE id=$1", [next])).rows[0]
      .status,
    "completed",
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].messages.at(-1).content, "New independent question");
  assert.match(seen[0].messages[0].content, /không tự chạy lại/i);
});
test("a slow chat does not hold another chat or delivery; turns within each chat remain ordered", async () => {
  await reset();
  await connect("hermes");
  const a = randomUUID(),
    b = randomUUID();
  const slowId = await enqueue(a, "slow", "dashboard", "hold");
  const nextId = await enqueue(a, "slow", "dashboard", "Second turn");
  const quickId = await enqueue(b, "fast", "dashboard", "Quick turn");
  const engine = new Engine(2),
    slow = engine.tick();
  try {
    for (let i = 0; !releaseResponse && i < 200; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(releaseResponse);
    await engine.tick();
    assert.equal(
      (await query("SELECT status FROM tasks WHERE id=$1", [quickId])).rows[0]
        .status,
      "completed",
    );
    assert.equal(
      (await query("SELECT status FROM tasks WHERE id=$1", [slowId])).rows[0]
        .status,
      "running",
    );
    assert.equal(
      (await query("SELECT status FROM tasks WHERE id=$1", [nextId])).rows[0]
        .status,
      "queued",
    );
    await new ZaloBridge().flush();
    assert.equal(
      (await query("SELECT status FROM outbox WHERE task_id=$1", [quickId]))
        .rows[0].status,
      "sent",
    );
    await engine.tick();
    assert.equal(seen.length, 2);
  } finally {
    releaseResponse?.();
    releaseResponse = undefined;
    await slow;
  }
  await engine.tick();
  assert.equal(
    (await query("SELECT status FROM tasks WHERE id=$1", [nextId])).rows[0]
      .status,
    "completed",
  );
  assert.equal(engine.activeCount, 0);
});
test("Hermes provider errors are sanitized, persist beyond health checks, and send one failure notice", async () => {
  await reset();
  await connect("hermes");
  const account = "111",
    uid = "222";
  await query("UPDATE settings SET value=$1 WHERE key='zalo'", [
    { allowUsers: [], allowGroups: [], groupsEnabled: false },
  ]);
  await setReplyMode(account, "dm", uid, "all");
  const sends: any[] = [];
  const bridge = new ZaloBridge();
  bridge.status = "connected";
  bridge.api = {
    getOwnId: () => account,
    sendMessage: async (...args: any[]) => sends.push(args),
  } as any;
  await bridge.receive(
    new UserMessage(account, {
      uidFrom: uid,
      idTo: account,
      msgId: "error-notice",
      content: "Question",
      dName: "An",
    } as any),
  );
  mode = "hermes-error";
  const engine = new Engine();
  await engine.tick();
  const t = (await query("SELECT * FROM tasks")).rows[0];
  assert.equal(t.status, "review");
  assert.match(t.error, /403/);
  assert.doesNotMatch(t.error, /PRIVATE_DIAGNOSTIC_TOKEN/);
  mode = "answer";
  await query(
    "UPDATE agents SET run_cooldown_until=now()-interval '1 second' WHERE id='hermes'",
  );
  await checkAgent("hermes");
  assert.match(
    (await query("SELECT last_run_error FROM agents WHERE id='hermes'")).rows[0]
      .last_run_error,
    /403/,
  );
  await bridge.flush();
  await bridge.flush();
  await engine.tick();
  assert.equal(sends.length, 1);
  assert.match(sends[0][0], /chưa nhận được câu trả lời/);
  assert.equal((await query("SELECT kind FROM outbox")).rows[0].kind, "notice");
  await bridge.receive(
    new UserMessage(account, {
      uidFrom: uid,
      idTo: account,
      msgId: "after-error",
      content: "New question",
      dName: "An",
    } as any),
  );
  await engine.tick();
  await bridge.flush();
  assert.equal(sends.length, 2);
  assert.equal(
    (await query("SELECT last_run_error FROM agents WHERE id='hermes'")).rows[0]
      .last_run_error,
    null,
  );
});
test("restart preserves queued task and fences interrupted runs", async () => {
  await reset();
  const t = await enqueue(randomUUID(), "restart", "dashboard", "A");
  await query("UPDATE tasks SET status='running' WHERE id=$1", [t]);
  const queued = await enqueue(randomUUID(), "restart", "dashboard", "B");
  await recover();
  assert.equal(
    (await query("SELECT status FROM tasks WHERE id=$1", [t])).rows[0].status,
    "review",
  );
  assert.equal(
    (await query("SELECT status FROM tasks WHERE id=$1", [queued])).rows[0]
      .status,
    "queued",
  );
});

test("real SDK DM shape with 19-digit UID passes allowlist and queues once", async () => {
  await reset();
  await query("UPDATE settings SET value=$1 WHERE key='zalo'", [
    {
      allowUsers: ["2222222222222222222"],
      allowGroups: [],
      groupsEnabled: false,
    },
  ]);
  const bridge = new ZaloBridge();
  const message = new UserMessage("1111111111111111111", {
    uidFrom: "2222222222222222222",
    idTo: "0",
    msgId: "9876543210987654321",
    content: "test DM",
    dName: "Allowed contact",
  } as any);
  await bridge.receive(message);
  await bridge.receive(message);
  assert.equal(bridge.diagnostics.accepted, 1);
  assert.equal(bridge.diagnostics.duplicates, 1);
  const task = (await query("SELECT * FROM tasks")).rows[0];
  assert.equal(task.status, "queued");
  const conversation = (await query("SELECT * FROM conversations")).rows[0];
  assert.equal(conversation.thread_id, "2222222222222222222");
});
test("DM receive diagnostics distinguish denied, self and non-text messages", async () => {
  await reset();
  await query("UPDATE settings SET value=$1 WHERE key='zalo'", [
    {
      allowUsers: ["2222222222222222222"],
      allowGroups: [],
      groupsEnabled: false,
    },
  ]);
  const bridge = new ZaloBridge();
  await bridge.receive({
    type: 0,
    threadId: "other",
    isSelf: false,
    data: { uidFrom: "other", content: "private text" },
  });
  assert.equal(bridge.diagnostics.lastDecision, "not_allowed");
  await bridge.receive({
    isSelf: true,
    data: { uidFrom: "1111111111111111111", content: "outbound" },
  });
  assert.equal(bridge.diagnostics.lastDecision, "self");
  await bridge.receive({
    isSelf: false,
    data: { uidFrom: "2222222222222222222", content: { href: "file" } },
  });
  assert.equal(bridge.diagnostics.lastDecision, "unsupported_content");
  assert.equal(
    (await query("SELECT count(*)::int AS count FROM tasks")).rows[0].count,
    0,
  );
});

test("allowed DM goes through Hermes and replies to the same Zalo thread", async () => {
  await reset();
  await connect("hermes");
  await query("UPDATE settings SET value=$1 WHERE key='zalo'", [
    {
      allowUsers: ["2222222222222222222"],
      allowGroups: [],
      groupsEnabled: false,
    },
  ]);
  const { EventEmitter } = await import("node:events");
  const listener = new EventEmitter() as any;
  let options: any;
  listener.start = (o: any) => {
    options = o;
    listener.emit("connected");
  };
  listener.stop = () => {};
  const sends: any[] = [];
  const bridge = new ZaloBridge();
  await bridge.attach({
    listener,
    getOwnId: () => "1111111111111111111",
    sendMessage: async (...args: any[]) => {
      sends.push(args);
    },
  } as any);
  assert.equal(options.retryOnClose, false);
  listener.emit("error", new Error("decode failure"));
  assert.equal(
    bridge.status,
    "connected",
    "A decoding error must not permanently disable sending",
  );
  const message = new UserMessage("1111111111111111111", {
    uidFrom: "2222222222222222222",
    idTo: "0",
    msgId: "1112223334445556667",
    content: "test DM pipeline",
    dName: "Contact",
  } as any);
  await bridge.receive(message);
  await new Engine().tick();
  await bridge.flush();
  assert.equal(sends.length, 1);
  assert.equal(sends[0][1], "2222222222222222222");
  assert.equal(sends[0][2], 0);
  assert.equal(
    (await query("SELECT status FROM outbox")).rows[0].status,
    "sent",
  );
});

test("contacts retain observed blocked DM metadata without storing message content", async () => {
  await reset();
  await query("UPDATE settings SET value=$1 WHERE key='zalo'", [
    { allowUsers: [], allowGroups: [], groupsEnabled: false },
  ]);
  const bridge = new ZaloBridge();
  bridge.api = { getOwnId: () => "1111111111111111111" } as any;
  await bridge.receive(
    new UserMessage("1111111111111111111", {
      uidFrom: "3333333333333333333",
      idTo: "0",
      msgId: "pending-contact",
      dName: "Test contact",
      content: "Private text must not be stored for denied contact",
    } as any),
  );
  const result = await listContacts("1111111111111111111");
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].uid, "3333333333333333333");
  assert.equal(result.contacts[0].display_name, "Test contact");
  assert.equal(result.contacts[0].allowed, false);
  assert.equal(
    (await query("SELECT count(*)::int AS n FROM messages")).rows[0].n,
    0,
  );
  assert.equal((await listContacts("9999999999999999999")).contacts.length, 0);
});
test("grant/revoke is persistent, idempotent, serialized and preserves group policy", async () => {
  await reset();
  await query("UPDATE settings SET value=$1 WHERE key='zalo'", [
    { allowUsers: [], allowGroups: ["888"], groupsEnabled: true },
  ]);
  await observeContact(
    "1111111111111111111",
    "3333333333333333333",
    "Test contact",
  );
  await Promise.all([
    setContactAccess("1111111111111111111", "3333333333333333333", true),
    setContactAccess("1111111111111111111", "2222222222222222222", true),
  ]);
  await setContactAccess("1111111111111111111", "3333333333333333333", true);
  let policy = (await query("SELECT value FROM settings WHERE key='zalo'"))
    .rows[0].value;
  assert.equal(policy.allowUsers.length, 2);
  assert.deepEqual(policy.allowGroups, ["888"]);
  assert.equal(policy.groupsEnabled, true);
  assert.equal(
    (await listContacts("1111111111111111111")).contacts.find(
      (c) => c.uid === "3333333333333333333",
    ).allowed,
    true,
  );
  await setContactAccess("1111111111111111111", "3333333333333333333", false);
  assert.equal(
    (await listContacts("1111111111111111111")).contacts.find(
      (c) => c.uid === "3333333333333333333",
    ).allowed,
    false,
  );
  await assert.rejects(
    setContactAccess("1111111111111111111", "1111111111111111111", true),
    /chính tài khoản bot/,
  );
});
test("revoked contact cannot receive pending reply", async () => {
  await reset();
  await connect("hermes");
  await query("UPDATE settings SET value=$1 WHERE key='zalo'", [
    {
      allowUsers: ["3333333333333333333"],
      allowGroups: [],
      groupsEnabled: false,
    },
  ]);
  const bridge = new ZaloBridge();
  let sent = 0;
  bridge.api = {
    getOwnId: () => "1111111111111111111",
    sendMessage: async () => {
      sent++;
    },
  } as any;
  bridge.status = "connected";
  await bridge.receive(
    new UserMessage("1111111111111111111", {
      uidFrom: "3333333333333333333",
      idTo: "0",
      msgId: "revoke-before-send",
      content: "Test pending reply",
      dName: "Contact",
    } as any),
  );
  await new Engine().tick();
  await setContactAccess("1111111111111111111", "3333333333333333333", false);
  await bridge.flush();
  assert.equal(sent, 0);
  assert.equal(
    (await query("SELECT status FROM outbox")).rows[0].status,
    "cancelled",
  );
});

test("groups and DMs with the same ID have separate metadata and access", async () => {
  await reset();
  await query("UPDATE settings SET value=$1 WHERE key='zalo'", [
    {
      allowUsers: ["7777777777777777777"],
      allowGroups: [],
      groupsEnabled: false,
    },
  ]);
  await observeContact(
    "1111111111111111111",
    "7777777777777777777",
    "DM person",
  );
  await observeGroup(
    "1111111111111111111",
    "7777777777777777777",
    "Group title",
  );
  let contacts = (await listContacts("1111111111111111111")).contacts;
  assert.equal(
    contacts.filter((c) => c.uid === "7777777777777777777").length,
    2,
  );
  assert.equal(contacts.find((c) => c.kind === "dm").allowed, true);
  assert.equal(contacts.find((c) => c.kind === "group").allowed, false);
  await setGroupAccess("1111111111111111111", "7777777777777777777", true);
  contacts = (await listContacts("1111111111111111111")).contacts;
  assert.equal(
    contacts.find((c) => c.kind === "group").effective,
    false,
    "Grant must not silently enable group responses",
  );
  await setGroupsEnabled("1111111111111111111", true);
  contacts = (await listContacts("1111111111111111111")).contacts;
  assert.equal(contacts.find((c) => c.kind === "group").effective, true);
  await setGroupAccess("1111111111111111111", "7777777777777777777", false);
  const policy = (await query("SELECT value FROM settings WHERE key='zalo'"))
    .rows[0].value;
  assert.deepEqual(policy.allowUsers, ["7777777777777777777"]);
  assert.equal(policy.groupsEnabled, true);
});
test("blocked group message is discoverable without storing its content", async () => {
  await reset();
  await query("UPDATE settings SET value=$1 WHERE key='zalo'", [
    { allowUsers: [], allowGroups: [], groupsEnabled: true },
  ]);
  const bridge = new ZaloBridge();
  bridge.api = { getOwnId: () => "1111111111111111111" } as any;
  await bridge.receive(
    new GroupMessage("1111111111111111111", {
      uidFrom: "3333333333333333333",
      idTo: "4444444444444444444",
      content: "Private blocked group content",
      msgId: "blocked-group-test",
      dName: "Sender is not group title",
    } as any),
  );
  const row = (await listContacts("1111111111111111111")).contacts.find(
    (c) => c.kind === "group",
  );
  assert.equal(row.uid, "4444444444444444444");
  assert.equal(row.allowed, false);
  assert.equal(row.display_name, "");
  assert.equal(row.message_count, 1);
  assert.equal(
    (await query("SELECT count(*)::int AS n FROM messages")).rows[0].n,
    0,
  );
});
test("membership sync lists group names without granting access or reading history", async () => {
  await reset();
  await query("UPDATE settings SET value=$1 WHERE key='zalo'", [
    { allowUsers: [], allowGroups: [], groupsEnabled: false },
  ]);
  const bridge = new ZaloBridge();
  bridge.status = "connected";
  bridge.api = {
    getOwnId: () => "1111111111111111111",
    getAllGroups: async () => ({ gridVerMap: { "4444444444444444444": "1" } }),
    getGroupInfo: async (ids: string[]) => {
      assert.deepEqual(ids, ["4444444444444444444"]);
      return {
        gridInfoMap: {
          "4444444444444444444": { name: "Group synced", totalMember: 3 },
        },
      };
    },
  } as any;
  assert.equal(await bridge.syncGroups(), 1);
  const result = await listContacts("1111111111111111111");
  const group = result.contacts.find((c) => c.kind === "group");
  assert.equal(group.display_name, "Group synced");
  assert.equal(group.member_count, 3);
  assert.equal(group.message_count, 0);
  assert.equal(group.last_seen, null);
  assert.equal(group.allowed, false);
  assert.equal(result.groupsEnabled, false);
});

test("approved group keeps group title and sends reply to group rather than sender", async () => {
  await reset();
  await connect("hermes");
  await query("UPDATE settings SET value=$1 WHERE key='zalo'", [
    {
      allowUsers: [],
      allowGroups: ["4444444444444444444"],
      groupsEnabled: true,
    },
  ]);
  await observeGroup(
    "1111111111111111111",
    "4444444444444444444",
    "Group title",
  );
  const sends: any[] = [];
  const bridge = new ZaloBridge();
  bridge.status = "connected";
  bridge.api = {
    getOwnId: () => "1111111111111111111",
    sendMessage: async (...args: any[]) => {
      sends.push(args);
    },
  } as any;
  await bridge.receive(
    new GroupMessage("1111111111111111111", {
      uidFrom: "3333333333333333333",
      idTo: "4444444444444444444",
      content: "Group task test",
      msgId: "approved-group",
      dName: "Sender name",
    } as any),
  );
  assert.equal(
    (await query("SELECT title FROM conversations")).rows[0].title,
    "Group title",
  );
  await new Engine().tick();
  await bridge.flush();
  assert.equal(sends.length, 1);
  assert.equal(sends[0][1], "4444444444444444444");
  assert.equal(sends[0][2], 1);
});

test("group join event discovers a group without a chat message", async () => {
  await reset();
  await query("UPDATE settings SET value=$1 WHERE key='zalo'", [
    { allowUsers: [], allowGroups: [], groupsEnabled: false },
  ]);
  const { EventEmitter } = await import("node:events");
  const listener: any = new EventEmitter();
  listener.start = () => listener.emit("connected");
  listener.stop = () => {};
  const bridge = new ZaloBridge();
  await bridge.attach({
    listener,
    getOwnId: () => "1111111111111111111",
  } as any);
  listener.emit("group_event", {
    type: "join",
    threadId: "4444444444444444444",
    data: { groupId: "4444444444444444444", groupName: "Joined group" },
  });
  let group: any;
  for (let i = 0; i < 30; i++) {
    group = (await listContacts("1111111111111111111")).contacts.find(
      (c) => c.kind === "group",
    );
    if (group) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(group.display_name, "Joined group");
  assert.equal(group.allowed, false);
  assert.equal(group.message_count, 0);
});

test("mention mode admits only a real bot tag and preserves it through delivery", async () => {
  await reset();
  await connect("hermes");
  await query("UPDATE settings SET value=$1 WHERE key='zalo'", [
    { allowUsers: [], allowGroups: [], groupsEnabled: true },
  ]);
  await setReplyMode(
    "1111111111111111111",
    "group",
    "4444444444444444444",
    "mention",
  );
  const sent: any[] = [];
  const bridge = new ZaloBridge();
  bridge.status = "connected";
  bridge.api = {
    getOwnId: () => "1111111111111111111",
    sendMessage: async (...args: any[]) => {
      sent.push(args);
    },
  } as any;
  const msg = (id: string, mentions?: any[]) =>
    new GroupMessage("1111111111111111111", {
      uidFrom: "3333333333333333333",
      idTo: "4444444444444444444",
      msgId: id,
      content: "@bot hello",
      mentions,
      dName: "Person",
    } as any);
  await bridge.receive(msg("no-mention"));
  await bridge.receive(
    msg("tag-other", [{ uid: "-1" }, { uid: "2222222222222222222" }]),
  );
  assert.equal(
    (await query("SELECT count(*)::int AS n FROM tasks")).rows[0].n,
    0,
  );
  await bridge.receive(msg("tag-bot", [{ uid: "1111111111111111111" }]));
  const metadata = (
    await query(
      "SELECT bot_mentioned,source_account_id FROM messages WHERE role='user'",
    )
  ).rows[0];
  assert.equal(metadata.bot_mentioned, true);
  assert.equal(metadata.source_account_id, "1111111111111111111");
  await new Engine().tick();
  await bridge.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1], "4444444444444444444");
});
test("silent mode persists, removes access and never queues even tagged messages", async () => {
  await reset();
  await query("UPDATE settings SET value=$1 WHERE key='zalo'", [
    { allowUsers: [], allowGroups: [], groupsEnabled: true },
  ]);
  await setReplyMode(
    "1111111111111111111",
    "group",
    "4444444444444444444",
    "all",
  );
  await setReplyMode(
    "1111111111111111111",
    "group",
    "4444444444444444444",
    "silent",
  );
  const bridge = new ZaloBridge();
  bridge.api = { getOwnId: () => "1111111111111111111" } as any;
  await bridge.receive(
    new GroupMessage("1111111111111111111", {
      uidFrom: "3333333333333333333",
      idTo: "4444444444444444444",
      msgId: "silent-tag",
      content: "Hi",
      mentions: [{ uid: "1111111111111111111" }],
    } as any),
  );
  assert.equal(
    (await query("SELECT count(*)::int AS n FROM tasks")).rows[0].n,
    0,
  );
  const row = (await listContacts("1111111111111111111")).contacts.find(
    (c) => c.kind === "group",
  );
  assert.equal(row.mode, "silent");
  assert.equal(row.allowed, false);
  assert.equal(row.uid, "4444444444444444444");
});
test("mode change cancels queued work and pending untagged replies", async () => {
  await reset();
  await connect("hermes");
  await query("UPDATE settings SET value=$1 WHERE key='zalo'", [
    { allowUsers: [], allowGroups: [], groupsEnabled: true },
  ]);
  await setReplyMode(
    "1111111111111111111",
    "group",
    "4444444444444444444",
    "all",
  );
  let sent = 0;
  const bridge = new ZaloBridge();
  bridge.status = "connected";
  bridge.api = {
    getOwnId: () => "1111111111111111111",
    sendMessage: async () => {
      sent++;
    },
  } as any;
  const msg = (id: string) =>
    new GroupMessage("1111111111111111111", {
      uidFrom: "3333333333333333333",
      idTo: "4444444444444444444",
      msgId: id,
      content: "Hello",
    } as any);
  await bridge.receive(msg("cancel-queue"));
  await setReplyMode(
    "1111111111111111111",
    "group",
    "4444444444444444444",
    "mention",
  );
  await new Engine().tick();
  assert.equal(
    (await query("SELECT status FROM tasks")).rows[0].status,
    "cancelled",
  );
  assert.equal(seen.length, 0);
  await setReplyMode(
    "1111111111111111111",
    "group",
    "4444444444444444444",
    "all",
  );
  await bridge.receive(msg("cancel-delivery"));
  await new Engine().tick();
  await setReplyMode(
    "1111111111111111111",
    "group",
    "4444444444444444444",
    "mention",
  );
  await bridge.flush();
  assert.equal(sent, 0);
  assert.equal(
    (await query("SELECT status FROM outbox")).rows[0].status,
    "cancelled",
  );
});
test("row modes are isolated by chat kind and bulk editor preserves unchanged mention mode", async () => {
  await reset();
  const account = "1111111111111111111",
    id = "7777777777777777777";
  await query("UPDATE settings SET value=$1 WHERE key='zalo'", [
    { allowUsers: [], allowGroups: [], groupsEnabled: true },
  ]);
  await setReplyMode(account, "dm", id, "mention");
  await setReplyMode(account, "group", id, "all");
  assert.equal(await replyMode(account, "dm", id), "mention");
  assert.equal(await replyMode(account, "group", id), "all");
  await replaceZaloPolicy(account, {
    allowUsers: [id, "8888888888888888888"],
    allowGroups: [id],
    groupsEnabled: true,
  });
  assert.equal(await replyMode(account, "dm", id), "mention");
  assert.equal(await replyMode(account, "dm", "8888888888888888888"), "all");
  await setReplyMode(account, "group", id, "silent");
  assert.equal(await replyMode(account, "dm", id), "mention");
  assert.equal(await replyMode(account, "group", id), "silent");
});

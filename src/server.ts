import "dotenv/config";
import { setReplyMode, replaceZaloPolicy } from "./reply-policy.js";

import multipart from "@fastify/multipart";
import {
  getChatProfile,
  saveChatProfile,
  profileSchema,
} from "./chat-profiles.js";
import {
  addSource,
  refreshSource,
  sourceList,
  removeSource,
  browseLibrary,
} from "./knowledge.js";
import { guardStatus, policyDir, needsGuard } from "./command-guard.js";
import { decrypt } from "./security.js";
import { resolve } from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { readFile, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { query, pool, migrate, event, setting } from "./db.js";
import { initSecrets, equal, encrypt } from "./security.js";
import { checkAgent, reconcile } from "./agents.js";
import { Engine, enqueue, recover } from "./engine.js";
import { ZaloBridge } from "./zalo.js";
import {
  listContacts,
  setContactAccess,
  setGroupAccess,
  setGroupsEnabled,
} from "./contacts.js";
const token = await initSecrets();
await migrate();
// One worker/bridge per database; fail closed if a second instance starts.
const lock = await pool.connect();
if (
  !(await lock.query("SELECT pg_try_advisory_lock(938901) AS acquired")).rows[0]
    .acquired
)
  throw new Error("Một dịch vụ khác đang giữ quyền chạy bot.");
lock.on("error", () => process.exit(1));
await recover();
const app = Fastify({ logger: false, bodyLimit: 65536 });
await app.register(cookie);
await app.register(multipart, {
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});
for (const [route, file, type] of [
  ["/", "index.html", "text/html; charset=utf-8"],
  ["/style.css", "style.css", "text/css; charset=utf-8"],
  ["/app.js", "app.js", "text/javascript; charset=utf-8"],
]) {
  app.get(route, async (req, reply) =>
    reply
      .type(type)
      .send(await readFile(new URL("../public/" + file, import.meta.url))),
  );
}
const sessions = new Map<string, number>(),
  loginAttempts = new Map<string, { count: number; until: number }>();
const bridge = new ZaloBridge(),
  engine = new Engine();
let dbError = false;
app.addHook("onRequest", async (req, reply) => {
  reply
    .header("Cache-Control", "no-store")
    .header("X-Content-Type-Options", "nosniff")
    .header("X-Frame-Options", "DENY")
    .header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
  if (!req.url.startsWith("/api/")) return;
  const hostname = (req.headers.host || "").split(":")[0];
  if (
    !["127.0.0.1", "localhost"].includes(hostname) &&
    process.env.ALLOWED_HOST !== hostname
  )
    return reply.code(403).send({ error: "Host không được cho phép" });
  const origin = req.headers.origin;
  if (
    origin &&
    origin !== `http://${req.headers.host}` &&
    origin !== `https://${req.headers.host}`
  )
    return reply.code(403).send({ error: "Origin không hợp lệ" });
  if (
    req.url === "/api/login" ||
    req.url === "/api/session" ||
    req.url.startsWith("/api/tool-policy/")
  )
    return;
  const session = req.cookies.hub_session;
  if (!session || !sessions.has(session) || sessions.get(session)! < Date.now())
    return reply.code(401).send({ error: "Vui lòng đăng nhập" });
});
app.setErrorHandler((err: any, req, reply) => {
  if (err instanceof z.ZodError)
    return reply.code(400).send({
      error: err.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    });
  reply.code(err.statusCode || 500).send({
    error: err.statusCode
      ? err.message
      : "Không thể xử lý yêu cầu. Kiểm tra kết nối database hoặc cấu hình.",
  });
});
app.post("/api/login", async (req, reply) => {
  const { token: input } = z
    .object({ token: z.string().max(300) })
    .parse(req.body);
  const now = Date.now(),
    attempt = loginAttempts.get(req.ip);
  if (attempt && attempt.until > now && attempt.count >= 8)
    return reply.code(429).send({ error: "Thử lại sau 60 giây" });
  if (!equal(input, token)) {
    loginAttempts.set(req.ip, {
      count: attempt && attempt.until > now ? attempt.count + 1 : 1,
      until: now + 60000,
    });
    return reply.code(401).send({ error: "Mã quản trị không đúng" });
  }
  loginAttempts.delete(req.ip);
  const id = randomUUID();
  sessions.set(id, now + 12 * 3600000);
  reply.setCookie("hub_session", id, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: 43200,
    secure: req.protocol === "https",
  });
  return { ok: true };
});
app.get("/api/session", async (req) => ({
  authenticated:
    !!req.cookies.hub_session &&
    (sessions.get(req.cookies.hub_session) || 0) > Date.now(),
}));
app.post("/api/logout", async (req, reply) => {
  if (req.cookies.hub_session) sessions.delete(req.cookies.hub_session);
  reply.clearCookie("hub_session", { path: "/" });
  return { ok: true };
});
app.get("/api/overview", async () => {
  const [agents, counts, tasks, events, leadership, config] = await Promise.all(
    [
      query(
        "SELECT id,enabled,base_url,model,health,failures,last_checked,last_ok,latency_ms,error,last_run_error,last_run_at,last_run_ms,(secret <> '') AS has_key FROM agents ORDER BY id",
      ),
      query(
        "SELECT (SELECT count(*) FROM conversations)::int AS conversations,(SELECT count(*) FROM messages)::int AS messages,(SELECT count(*) FROM tasks WHERE status='queued')::int AS queued,(SELECT count(*) FROM tasks WHERE status='review')::int AS review",
      ),
      query("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 8"),
      query("SELECT * FROM events ORDER BY id DESC LIMIT 12"),
      query("SELECT * FROM leadership WHERE id=1"),
      setting("routing"),
    ],
  );
  return {
    agents: agents.rows,
    counts: counts.rows[0],
    tasks: tasks.rows,
    events: events.rows,
    leadership: leadership.rows[0],
    routing: config,
    zalo: bridge.state(),
    database: { status: "online", engine: "PostgreSQL", ha: false },
    worker: {
      busy: engine.busy,
      active: engine.activeCount,
      concurrency: engine.concurrency,
      dbError,
    },
  };
});
const agentInput = z.object({
  enabled: z.boolean(),
  baseUrl: z
    .url()
    .refine(
      (v) => ["http:", "https:"].includes(new URL(v).protocol),
      "Chỉ hỗ trợ HTTP/HTTPS",
    )
    .refine(
      (v) =>
        !new URL(v).username &&
        !new URL(v).password &&
        !new URL(v).search &&
        !new URL(v).hash,
      "URL không được chứa thông tin đăng nhập, query hoặc hash",
    ),
  model: z.string().trim().min(1).max(150),
  apiKey: z.string().max(1000).optional(),
});
app.put("/api/agents/:id", async (req) => {
  const { id } = z
    .object({ id: z.enum(["hermes", "openclaw"]) })
    .parse(req.params);
  const data = agentInput.parse(req.body);
  await query(
    "UPDATE agents SET enabled=$2,base_url=$3,model=$4,secret=CASE WHEN $5::text IS NULL OR $5='' THEN secret ELSE $6 END,health=CASE WHEN $2 THEN 'checking' ELSE 'unconfigured' END,failures=0,healthy_since=null,run_cooldown_until=null,error=null WHERE id=$1",
    [
      id,
      data.enabled,
      data.baseUrl.replace(/\/+$/, ""),
      data.model,
      data.apiKey || null,
      encrypt(data.apiKey || ""),
    ],
  );
  await event("config", `Cập nhật kết nối ${id}`);
  return { ok: true };
});
app.post("/api/agents/:id/check", async (req) => {
  const { id } = z
    .object({ id: z.enum(["hermes", "openclaw"]) })
    .parse(req.params);
  await checkAgent(id);
  if (!engine.busy) await reconcile();
  return { ok: true };
});
app.put("/api/routing", async (req) => {
  const data = z
    .object({
      preferred: z.enum(["auto", "hermes", "openclaw"]),
      failureThreshold: z.number().int().min(1).max(10),
      recoverySeconds: z.number().int().min(10).max(600),
      paused: z.boolean(),
    })
    .parse(req.body);
  await query("UPDATE settings SET value=$1 WHERE key='routing'", [data]);
  if (!engine.busy) await reconcile();
  await event("config", "Cập nhật chính sách Main / Backup");
  return { ok: true };
});
app.get("/api/tool-policy/:session", async (req, reply) => {
  const { session } = z
    .object({ session: z.string().regex(/^zhub_[a-f0-9]{32}$/) })
    .parse(req.params);
  try {
    const request = JSON.parse(
      await readFile(resolve(policyDir, session + ".json"), "utf8"),
    );
    if (
      request.expires < Date.now() / 1000 ||
      !equal(String(req.headers.authorization || ""), "Bearer " + request.token)
    )
      return reply.code(403).send({ error: "Invalid policy token" });
    const p = await getChatProfile(
      request.accountId,
      request.kind,
      request.uid,
    );
    return {
      systemCommands: p.systemCommands,
      denied: p.deniedCommands
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean),
    };
  } catch {
    return reply.code(403).send({ error: "Policy unavailable" });
  }
});
const profileScope = (req: any) => {
  const params = z
    .object({
      kind: z.enum(["dm", "group"]),
      uid: z.string().regex(/^\d{1,30}$/),
    })
    .parse(req.params);
  const accountId = String(req.query?.accountId || req.body?.accountId || "");
  if (!/^\d{1,30}$/.test(accountId) || bridge.state().accountId !== accountId)
    throw Object.assign(
      new Error("Tài khoản bot đã thay đổi hoặc chưa kết nối. Tải lại trang."),
      { statusCode: 409 },
    );
  return { ...params, accountId };
};
app.get("/api/chat-profile/:kind/:uid", async (req) => {
  const s = profileScope(req);
  return {
    profile: await getChatProfile(s.accountId, s.kind, s.uid),
    sources: await sourceList(s.accountId, s.kind, s.uid),
    guard: await guardStatus(),
  };
});
app.put("/api/chat-profile/:kind/:uid", async (req) => {
  const s = profileScope(req);
  const p = profileSchema.parse((req.body as any).profile);
  if (p.brain === "hermes" && p.model && !p.provider)
    throw Object.assign(
      new Error("Cần provider khi chọn model riêng cho Hermes"),
      { statusCode: 400 },
    );
  if (needsGuard(p) && (!(await guardStatus()).ready || p.brain === "openclaw"))
    throw Object.assign(
      new Error(
        "Chính sách lệnh hạn chế cần guard Hermes đang hoạt động. OpenClaw chưa hỗ trợ guard này.",
      ),
      { statusCode: 409 },
    );
  const profile = await saveChatProfile(s.accountId, s.kind, s.uid, p);
  await event("chat_profile", `Đã cập nhật cấu hình ${s.kind} ${s.uid}`);
  return { ok: true, profile };
});
app.get("/api/library/browse", async (req) =>
  browseLibrary(
    z.object({ path: z.string().max(2000).optional() }).parse(req.query).path,
  ),
);
app.get("/api/command-guard", async () => guardStatus());
app.post("/api/chat-profile/:kind/:uid/sources", async (req) => {
  const s = profileScope(req);
  const data = z
    .object({
      type: z.enum(["url", "folder", "skill", "note"]),
      name: z.string().max(200).optional(),
      locator: z.string().max(2000).optional(),
      content: z.string().max(60000).optional(),
    })
    .parse((req.body as any).source);
  return addSource(s.accountId, s.kind, s.uid, data);
});
app.post(
  "/api/chat-profile/:kind/:uid/upload",
  { bodyLimit: 10 * 1024 * 1024 },
  async (req) => {
    const s = profileScope(req);
    const file = await req.file();
    if (!file)
      throw Object.assign(new Error("Chọn một file"), { statusCode: 400 });
    const buffer = await file.toBuffer();
    return addSource(s.accountId, s.kind, s.uid, {
      type: "upload",
      name: file.filename,
      buffer,
    });
  },
);
app.post(
  "/api/chat-profile/:kind/:uid/sources/:sourceId/refresh",
  async (req) => {
    const s = profileScope(req);
    const { sourceId } = z.object({ sourceId: z.uuid() }).parse(req.params);
    return refreshSource(s.accountId, s.kind, s.uid, sourceId);
  },
);
app.delete("/api/chat-profile/:kind/:uid/sources/:sourceId", async (req) => {
  const s = profileScope(req);
  const { sourceId } = z.object({ sourceId: z.uuid() }).parse(req.params);
  return removeSource(s.accountId, s.kind, s.uid, sourceId);
});
app.get("/api/agents/:id/catalog", async (req) => {
  const { id } = z
    .object({ id: z.enum(["hermes", "openclaw"]) })
    .parse(req.params);
  const a = (await query("SELECT * FROM agents WHERE id=$1", [id])).rows[0];
  if (!a?.enabled) return { models: [] };
  const base =
    id === "hermes"
      ? a.base_url.replace(/\/v1$/, "") + "/api/model/options"
      : a.base_url + "/models";
  const response = await fetch(base, {
    headers: { Authorization: "Bearer " + decrypt(a.secret) },
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  });
  if (!response.ok)
    return {
      models: [],
      error: "Không lấy được danh sách model: HTTP " + response.status,
    };
  const payload: any = await response.json();
  const models: any[] = [];
  if (id === "hermes" && Array.isArray(payload.providers)) {
    for (const provider of [...payload.providers].sort(
      (x: any, y: any) =>
        Number(y.slug === payload.provider) -
        Number(x.slug === payload.provider),
    )) {
      for (const model of provider.models || []) {
        const modelId =
          typeof model === "string" ? model : model.id || model.model;
        if (modelId)
          models.push({
            id: String(modelId),
            provider: provider.slug,
            label: String(modelId) + " · " + provider.name,
          });
      }
    }
    if (
      payload.model &&
      payload.provider &&
      !models.some(
        (m) => m.id === payload.model && m.provider === payload.provider,
      )
    )
      models.unshift({
        id: payload.model,
        provider: payload.provider,
        label: payload.model + " · hiện tại",
      });
    return { models: models.slice(0, 1000) };
  }
  if (id === "openclaw")
    return {
      models: [],
      note: "Nhập ID provider/model. OpenClaw models chỉ liệt kê agent targets.",
    };

  function walk(value: any, provider = "") {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, provider);
      return;
    }
    const next =
      typeof value.provider === "string"
        ? value.provider
        : typeof value.provider_id === "string"
          ? value.provider_id
          : provider;
    if (
      typeof value.id === "string" &&
      (value.id.includes("/") ||
        value.id.includes("claude") ||
        value.id.includes("gpt") ||
        value.id.includes("gemini") ||
        value.id === "hermes-agent" ||
        id === "openclaw")
    )
      models.push({
        id: value.id,
        provider: next,
        label: String(value.label || value.name || value.id),
      });
    for (const [key, child] of Object.entries(value)) {
      if (["api_key", "token", "secret"].includes(key)) continue;
      walk(
        child,
        ["providers"].includes(key)
          ? ""
          : next ||
              (["models", "data", "options"].includes(key) ? provider : key),
      );
    }
  }
  walk(payload);
  return {
    models: [
      ...new Map(models.map((m) => [m.provider + ":" + m.id, m])).values(),
    ].slice(0, 600),
  };
});
app.get("/api/zalo", async () => ({
  ...bridge.state(),
  policy: await setting("zalo"),
}));
app.get("/api/zalo/contacts", async () =>
  listContacts(bridge.state().accountId),
);
app.put("/api/zalo/contacts/:uid/access", async (req) => {
  const { uid } = z
    .object({ uid: z.string().regex(/^\d{1,30}$/) })
    .parse(req.params);
  const { accountId, allowed } = z
    .object({ accountId: z.string().regex(/^\d{1,30}$/), allowed: z.boolean() })
    .parse(req.body);
  if (bridge.state().accountId !== accountId)
    throw Object.assign(
      new Error(
        "Tài khoản bot đã thay đổi hoặc chưa kết nối. Hãy tải lại danh sách.",
      ),
      { statusCode: 409 },
    );
  return setContactAccess(accountId, uid, allowed);
});
app.post("/api/zalo/groups/sync", async () => ({
  ok: true,
  count: await bridge.syncGroups(),
}));
app.put("/api/zalo/groups/:uid/access", async (req) => {
  const { uid } = z
    .object({ uid: z.string().regex(/^\d{1,30}$/) })
    .parse(req.params);
  const { accountId, allowed } = z
    .object({ accountId: z.string().regex(/^\d{1,30}$/), allowed: z.boolean() })
    .parse(req.body);
  if (bridge.state().accountId !== accountId)
    throw Object.assign(
      new Error("Tài khoản bot đã thay đổi hoặc chưa kết nối"),
      { statusCode: 409 },
    );
  return setGroupAccess(accountId, uid, allowed);
});
app.put("/api/zalo/groups-enabled", async (req) => {
  const { accountId, enabled } = z
    .object({ accountId: z.string().regex(/^\d{1,30}$/), enabled: z.boolean() })
    .parse(req.body);
  if (bridge.state().accountId !== accountId)
    throw Object.assign(
      new Error("Tài khoản bot đã thay đổi hoặc chưa kết nối"),
      { statusCode: 409 },
    );
  return setGroupsEnabled(accountId, enabled);
});
app.put("/api/zalo/reply-mode/:kind/:uid", async (req) => {
  const { kind, uid } = z
    .object({
      kind: z.enum(["dm", "group"]),
      uid: z.string().regex(/^\d{1,30}$/),
    })
    .parse(req.params);
  const { accountId, mode } = z
    .object({
      accountId: z.string().regex(/^\d{1,30}$/),
      mode: z.enum(["mention", "silent", "all"]),
    })
    .parse(req.body);
  if (bridge.state().accountId !== accountId)
    throw Object.assign(
      new Error("Tài khoản bot đã thay đổi hoặc chưa kết nối"),
      { statusCode: 409 },
    );
  return setReplyMode(accountId, kind, uid, mode);
});
app.post("/api/zalo/connect", async () => {
  bridge.start();
  return { ok: true };
});
app.post("/api/zalo/reconnect", async () => {
  void bridge.reconnect().catch(() => {});
  return { ok: true };
});
app.post("/api/zalo/disconnect", async () => {
  await bridge.disconnect();
  return { ok: true };
});
app.put("/api/zalo/policy", async (req) => {
  const data = z
    .object({
      allowUsers: z.array(z.string().regex(/^\d+$/)).max(500),
      allowGroups: z.array(z.string().regex(/^\d+$/)).max(500),
      groupsEnabled: z.boolean(),
    })
    .parse(req.body);
  await replaceZaloPolicy(bridge.state().accountId, data);
  await event("config", "Cập nhật quyền truy cập Zalo");
  return { ok: true };
});
app.get(
  "/api/conversations",
  async () =>
    (
      await query(
        "SELECT c.*,(SELECT count(*)::int FROM messages m WHERE m.conversation_id=c.id) AS message_count FROM conversations c ORDER BY updated_at DESC LIMIT 200",
      )
    ).rows,
);
app.get("/api/conversations/:id/messages", async (req) => {
  const { id } = req.params as any;
  return (
    await query(
      "SELECT * FROM (SELECT * FROM messages WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 500) recent ORDER BY created_at",
      [id],
    )
  ).rows;
});
app.post("/api/chat", async (req) => {
  const data = z
    .object({
      conversationId: z.string().uuid().optional(),
      content: z.string().trim().min(1).max(12000),
    })
    .parse(req.body);
  const id = data.conversationId || randomUUID();
  if (data.conversationId) {
    const c = (
      await query("SELECT source FROM conversations WHERE id=$1", [id])
    ).rows[0];
    if (c && c.source !== "dashboard")
      throw Object.assign(
        new Error("Chỉ thử chat trong cuộc hội thoại dashboard"),
        { statusCode: 400 },
      );
  }
  const task = await enqueue(
    id,
    data.content.slice(0, 60),
    "dashboard",
    data.content,
  );
  return { conversationId: id, taskId: task };
});
app.get(
  "/api/tasks",
  async () =>
    (await query("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 200"))
      .rows,
);
app.get("/api/tasks/:id", async (req) => {
  const { id } = z.object({ id: z.uuid() }).parse(req.params);
  const task = (
    await query(
      "SELECT t.*,m.content AS request FROM tasks t JOIN messages m ON m.id=t.message_id WHERE t.id=$1",
      [id],
    )
  ).rows[0];
  if (!task)
    throw Object.assign(new Error("Không tìm thấy công việc"), {
      statusCode: 404,
    });
  return {
    task,
    children: (
      await query(
        "SELECT t.*,m.content AS request FROM tasks t JOIN messages m ON m.id=t.message_id WHERE t.parent_id=$1 ORDER BY t.created_at",
        [id],
      )
    ).rows,
    childRuns: (
      await query(
        "SELECT r.* FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.parent_id=$1 ORDER BY r.created_at",
        [id],
      )
    ).rows,
    runs: (
      await query("SELECT * FROM runs WHERE task_id=$1 ORDER BY created_at", [
        id,
      ])
    ).rows,
  };
});
app.post("/api/tasks/:id/resolve", async (req) => {
  const { id } = z.object({ id: z.uuid() }).parse(req.params);
  const { action } = z
    .object({ action: z.enum(["acknowledge", "retry"]) })
    .parse(req.body);
  const task = (
    await query(
      "SELECT * FROM tasks WHERE id=$1 AND status IN ('failed','review')",
      [id],
    )
  ).rows[0];
  if (!task)
    throw Object.assign(new Error("Tác vụ không ở trạng thái cần xử lý"), {
      statusCode: 409,
    });
  if (
    (
      await query(
        "SELECT 1 FROM tasks WHERE parent_id=$1 AND status='review'",
        [id],
      )
    ).rowCount
  )
    throw Object.assign(new Error("Đối soát nhiệm vụ con trước"), {
      statusCode: 409,
    });
  if (
    action === "retry" &&
    (
      await query("SELECT 1 FROM outbox WHERE task_id=$1 AND kind='answer'", [
        id,
      ])
    ).rowCount
  )
    throw Object.assign(
      new Error("Đã có kết quả gửi; không chạy lại. Hãy xác nhận đã đối soát."),
      { statusCode: 409 },
    );
  if (action === "retry")
    await query(
      "UPDATE outbox SET status='cancelled' WHERE task_id=$1 AND kind='notice' AND status IN ('pending','review')",
      [id],
    );
  await query(
    "UPDATE tasks SET status=$2,error=null,updated_at=now() WHERE id=$1",
    [id, action === "retry" ? "queued" : "resolved"],
  );
  await event(
    "review",
    `${action === "retry" ? "Cho chạy lại" : "Đã đối soát"} ${id.slice(0, 8)}`,
  );
  return { ok: true };
});
app.get(
  "/api/memories",
  async () =>
    (
      await query(
        "SELECT m.*,c.title FROM memories m LEFT JOIN conversations c ON c.id=m.conversation_id ORDER BY m.created_at DESC LIMIT 200",
      )
    ).rows,
);
app.post("/api/memories", async (req) => {
  const data = z
    .object({
      conversationId: z.string().min(1),
      content: z.string().trim().min(1).max(4000),
    })
    .parse(req.body);
  await query(
    "INSERT INTO memories(id,conversation_id,content) VALUES($1,$2,$3)",
    [randomUUID(), data.conversationId, data.content],
  );
  return { ok: true };
});
app.delete("/api/memories/:id", async (req) => {
  const { id } = z.object({ id: z.uuid() }).parse(req.params);
  await query("DELETE FROM memories WHERE id=$1", [id]);
  return { ok: true };
});
app.get(
  "/api/events",
  async () =>
    (await query("SELECT * FROM events ORDER BY id DESC LIMIT 200")).rows,
);
app.get(
  "/api/outbox",
  async () =>
    (
      await query(
        "SELECT * FROM outbox WHERE status <> 'sent' ORDER BY created_at DESC LIMIT 100",
      )
    ).rows,
);
app.post("/api/outbox/:id/resolve", async (req) => {
  const { id } = z.object({ id: z.uuid() }).parse(req.params);
  const { action } = z
    .object({ action: z.enum(["sent", "retry"]) })
    .parse(req.body);
  await query(
    "UPDATE outbox SET status=$2,error=null WHERE id=$1 AND status='review'",
    [id, action === "sent" ? "sent" : "pending"],
  );
  await event("review", `Đối soát gửi tin ${id.slice(0, 8)}: ${action}`);
  return { ok: true };
});
let backingUp = false;
app.get("/api/backups", async () => {
  try {
    const names = (await readdir("backups"))
      .filter((n) => /^zalo-hub-[\w-]+\.dump$/.test(n))
      .sort()
      .reverse()
      .slice(0, 20);
    return Promise.all(
      names.map(async (name) => {
        const info = await stat("backups/" + name);
        return { name, size: info.size, createdAt: info.mtime };
      }),
    );
  } catch (e: any) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
});
app.post("/api/backups", async (req, reply) => {
  const dbUrl = new URL(
    process.env.DATABASE_URL ||
      "postgres://hub:hub_local_dev@127.0.0.1:55439/zalo_hub",
  );
  if (
    !["127.0.0.1", "localhost"].includes(dbUrl.hostname) ||
    dbUrl.port !== "55439" ||
    dbUrl.pathname !== "/zalo_hub"
  )
    return reply
      .code(400)
      .send({ error: "Nút backup hiện chỉ hỗ trợ database Compose cục bộ." });
  if (backingUp) return reply.code(409).send({ error: "Đang sao lưu" });
  backingUp = true;
  try {
    await promisify(execFile)(process.execPath, ["scripts/backup.mjs"], {
      timeout: 120000,
      maxBuffer: 100000,
    });
    await event("backup", "Đã tạo backup PostgreSQL cục bộ");
    return { ok: true };
  } catch {
    return reply.code(500).send({
      error: "Không sao lưu được. Kiểm tra Docker Compose và database cục bộ.",
    });
  } finally {
    backingUp = false;
  }
});
app.get("/health", async (req, reply) => {
  try {
    await query("SELECT 1");
    return { status: "ok" };
  } catch {
    return reply.code(503).send({ status: "database_unavailable" });
  }
});
let checking = false,
  sending = false;
const healthTimer = setInterval(async () => {
  if (checking) return;
  checking = true;
  try {
    await Promise.all(["hermes", "openclaw"].map(checkAgent));
    if (!engine.busy) await reconcile();
    dbError = false;
  } catch {
    dbError = true;
  } finally {
    checking = false;
  }
}, 10000);
const workTimer = setInterval(async () => {
  try {
    await engine.tick();
    dbError = false;
  } catch {
    dbError = true;
  }
}, 1000);
// Sending must keep progressing while an unrelated conversation is waiting
// for the model or a tool. Only one sender owns the outbox at a time.
const sendTimer = setInterval(async () => {
  if (sending) return;
  sending = true;
  try {
    await bridge.flush();
  } catch {
    dbError = true;
  } finally {
    sending = false;
  }
}, 500);
void bridge.restore().catch(() => {});
await app.listen({
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 3890),
});
console.log(
  `Zalo Agent Hub: http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 3890}\nMã quản trị: đọc file data/admin-token (không chia sẻ mã này).`,
);
async function shutdown() {
  clearInterval(healthTimer);
  clearInterval(workTimer);
  clearInterval(sendTimer);
  bridge.shutdown();
  await app.close();
  await query("UPDATE leadership SET generation=generation+1 WHERE id=1");
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

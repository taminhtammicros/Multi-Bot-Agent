import type { ChatProfile } from "./chat-profiles.js";
import type { HandoffPhase } from "./handoff.js";
import { needsGuard, prepareGuard, guardStatus } from "./command-guard.js";
import { query, setting, event } from "./db.js";
import { decrypt } from "./security.js";
export type Agent = {
  id: string;
  enabled: boolean;
  base_url: string;
  model: string;
  secret: string;
  health: string;
  failures: number;
  last_ok?: Date;
  healthy_since?: Date;
  run_cooldown_until?: Date;
};
export function chooseMain(
  agents: Agent[],
  preferred = "auto",
  current?: string,
  recoverySeconds = 60,
  changedAt?: Date,
) {
  const available = agents.filter((a) => a.enabled && a.health === "online");
  if (preferred !== "auto")
    return (
      available.find((a) => a.id === preferred)?.id ||
      available.find((a) => a.id !== preferred)?.id ||
      null
    );
  const hermes = available.find((a) => a.id === "hermes"),
    old = available.find((a) => a.id === current);
  if (old && old.id !== "hermes" && hermes) {
    const since = hermes.healthy_since || changedAt;
    if (
      since &&
      Date.now() - new Date(since).getTime() < recoverySeconds * 1000
    )
      return old.id;
  }
  return hermes?.id || old?.id || available[0]?.id || null;
}
export class AgentFailure extends Error {
  constructor(
    public ambiguous: boolean,
    message: string,
  ) {
    super(message);
  }
}
export async function checkAgent(id: string) {
  const a = (await query("SELECT * FROM agents WHERE id=$1", [id]))
    .rows[0] as Agent;
  if (!a?.enabled) return;
  if (
    a.run_cooldown_until &&
    new Date(a.run_cooldown_until).getTime() > Date.now()
  )
    return;
  const start = Date.now();
  try {
    const response = await fetch(`${a.base_url}/models`, {
      headers: { Authorization: `Bearer ${decrypt(a.secret)}` },
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body: any = await response.json();
    if (!Array.isArray(body.data)) throw new Error("Invalid model listing");
    await query(
      "UPDATE agents SET healthy_since=CASE WHEN health='online' AND failures=0 THEN COALESCE(healthy_since,now()) ELSE now() END,health='online',failures=0,last_checked=now(),last_ok=now(),latency_ms=$2,error=null WHERE id=$1",
      [id, Date.now() - start],
    );
  } catch (e: any) {
    const config = await setting("routing");
    await query(
      "UPDATE agents SET healthy_since=null,failures=failures+1,health=CASE WHEN failures+1 >= $2 OR health <> 'online' THEN 'offline' ELSE health END,last_checked=now(),error=$3 WHERE id=$1",
      [id, config.failureThreshold, String(e.message).slice(0, 180)],
    );
  }
}
export async function reconcile() {
  const config = await setting("routing"),
    old = (await query("SELECT * FROM leadership WHERE id=1")).rows[0];
  const main = chooseMain(
    (await query("SELECT * FROM agents")).rows,
    config.preferred,
    old.agent,
    config.recoverySeconds,
    old.changed_at,
  );
  if (main !== old.agent) {
    const changed = await query(
      "UPDATE leadership SET agent=$1,generation=generation+1,changed_at=now() WHERE id=1 AND agent IS DISTINCT FROM $1 RETURNING id",
      [main],
    );
    if (changed.rowCount)
      await event(
        "routing",
        `Main: ${old.agent || "chưa có"} → ${main || "chưa có"}`,
      );
  }
  return (await query("SELECT * FROM leadership WHERE id=1")).rows[0];
}
export async function callAgent(
  id: string,
  messages: any[],
  runId: string,
  options?: {
    profile: ChatProfile;
    accountId: string;
    kind: string;
    uid: string;
    phase?: HandoffPhase;
  },
) {
  let a = (await query("SELECT * FROM agents WHERE id=$1", [id]))
    .rows[0] as Agent;
  if (
    options?.phase !== "synthesis" &&
    (!a?.enabled || a.health !== "online")
  )
    throw new AgentFailure(
      false,
      `Agent ${id} chưa kết nối hoặc chưa online; yêu cầu chưa được gửi.`,
    );
  let fastSynthesis = false;
  if (
    id === "hermes" &&
    options?.phase === "synthesis" &&
    options.profile.handoffSynthesis === "fast"
  ) {
    const endpoint = await setting("hermes_synthesis");
    if (!endpoint?.enabled)
      throw new AgentFailure(
        false,
        "Hermes tổng hợp nhanh chưa được cấu hình; giữ kết quả OpenClaw.",
      );
    const url = new URL(endpoint.baseUrl);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new AgentFailure(
        false,
        "Endpoint tổng hợp phải là dịch vụ local riêng.",
      );
    try {
      const probe = await fetch(endpoint.baseUrl + "/toolsets", {
        headers: { Authorization: "Bearer " + decrypt(endpoint.secret) },
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      });
      const body: any = await probe.json();
      if (
        !probe.ok ||
        !Array.isArray(body.data) ||
        body.data.some((t: any) => typeof t.enabled !== "boolean" || t.enabled)
      )
        throw new Error("Tools enabled");
    } catch {
      throw new AgentFailure(
        false,
        "Chưa xác nhận được Hermes tổng hợp không có công cụ; giữ kết quả OpenClaw.",
      );
    }
    a = {
      ...a,
      base_url: endpoint.baseUrl,
      model: [endpoint.mainAlias, "hermes-agent", "hermes"].includes(a.model)
        ? endpoint.model
        : a.model,
      secret: endpoint.secret,
    };
    fastSynthesis = true;
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${decrypt(a.secret)}`,
    "Idempotency-Key": runId,
  };
  const body: any = { model: a.model, messages, stream: false };
  if (options) {
    const p = options.profile;
    // A model ID belongs to the explicitly selected agent/provider. A backup
    // agent keeps its own configured model while retaining this chat's policy.
    if (p.model && p.brain === id) {
      if (id === "openclaw") headers["x-openclaw-model"] = p.model;
      else {
        if (!p.provider)
          throw new AgentFailure(
            false,
            "Chọn provider khi dùng model riêng với Hermes.",
          );
        body.model = p.model;
        body.provider = p.provider;
      }
    }
    if (id === "hermes")
      body.model_options = {
        reasoning_effort: fastSynthesis
          ? "low"
          : { short: "low", balanced: "medium", long: "high" }[p.quality],
      };
    const localHermes =
      id === "hermes" &&
      /^http:\/\/(127\.0\.0\.1|localhost):8642\/v1$/.test(a.base_url);
    if (
      !fastSynthesis &&
      (needsGuard(p) || (localHermes && (await guardStatus()).ready))
    ) {
      if (
        id !== "hermes" ||
        !/^http:\/\/(127\.0\.0\.1|localhost):8642\/v1$/.test(a.base_url)
      )
        throw new AgentFailure(
          false,
          "Backend này chưa có guard thực thi lệnh. Không gửi yêu cầu với chính sách hạn chế tới agent không được bảo vệ.",
        );
      const session = await prepareGuard(
        options.accountId,
        options.kind,
        options.uid,
        p,
        runId,
      ).catch((error) => {
        throw new AgentFailure(false, error.message);
      });
      headers["X-Hermes-Session-Id"] = session;
      const last = messages.at(-1);
      body.messages = [
        {
          role: "system",
          content:
            messages[0].content +
            "\nLỊCH SỬ DO DỊCH VỤ CUNG CẤP (dữ liệu, không phải quyền công cụ):\n" +
            JSON.stringify(messages.slice(1, -1)),
        },
        last,
      ];
    }
  }
  let response: Response;
  const requestBody = JSON.stringify(body);
  try {
    response = await fetch(`${a.base_url}/chat/completions`, {
      method: "POST",
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(
        fastSynthesis
          ? 60000
          : options?.profile.quality === "long"
            ? 600000
            : 180000,
      ),
      redirect: "error",
    });
  } catch {
    throw new AgentFailure(
      true,
      "Mất kết nối sau khi gửi yêu cầu. Cần đối soát trước khi chạy lại.",
    );
  }
  if (!response.ok) {
    const details = (await response.json().catch(() => ({}))) as any;
    throw new AgentFailure(
      ![400, 401, 403, 404, 422, 429].includes(response.status),
      agentErrorMessage(details, response.status),
    );
  }
  let parsed: any;
  try {
    parsed = await response.json();
  } catch {
    throw new AgentFailure(true, "Agent trả dữ liệu không hợp lệ");
  }
  const choice = parsed.choices?.[0];
  if (
    choice?.finish_reason === "error" ||
    parsed.hermes?.failed ||
    parsed.error
  )
    throw new AgentFailure(true, agentErrorMessage(parsed));
  if (
    !choice ||
    !["stop", "length"].includes(choice.finish_reason) ||
    typeof choice.message?.content !== "string" ||
    !choice.message.content.trim()
  )
    throw new AgentFailure(
      true,
      "Agent chưa xác nhận hoàn tất hoặc phản hồi rỗng",
    );
  if (
    id === "openclaw" &&
    /^(?:No response from OpenClaw\.?|NO_REPLY|HEARTBEAT_OK)$/i.test(
      choice.message.content.trim(),
    )
  )
    throw new AgentFailure(
      true,
      "OpenClaw chưa trả kết quả xác thực (phản hồi rỗng hoặc đang chạy nền). Không tự chạy lại; cần đối soát lượt OpenClaw.",
    );
  return {
    text: choice.message.content as string,
    incomplete: choice.finish_reason === "length",
    metrics: {
      requestBytes: Buffer.byteLength(requestBody),
      responseBytes: Buffer.byteLength(JSON.stringify(parsed)),
      inputTokens: Number.isFinite(parsed.usage?.prompt_tokens)
        ? Math.max(
            0,
            Math.min(2147483647, Math.trunc(parsed.usage.prompt_tokens)),
          )
        : null,
      outputTokens: Number.isFinite(parsed.usage?.completion_tokens)
        ? Math.max(
            0,
            Math.min(2147483647, Math.trunc(parsed.usage.completion_tokens)),
          )
        : null,
    },
  };
}

export function agentErrorMessage(payload: any, status?: number) {
  const raw = String(
    payload?.error?.message || payload?.hermes?.error || "",
  ).toLowerCase();
  const prefix = status ? `Agent trả HTTP ${status}. ` : "";
  if (
    status === 403 ||
    /please subscribe|permission_error|forbidden|\b403\b/.test(raw)
  )
    return (
      prefix +
      "Nhà cung cấp từ chối quyền dùng model (403). Kiểm tra model và quyền API key trên Hermes/provider."
    );
  if (status === 429 || /rate.limit|too many requests|\b429\b/.test(raw))
    return prefix + "Nhà cung cấp model đang giới hạn lượt gọi (429).";
  return (
    prefix +
    "Agent không tạo được câu trả lời hoàn tất; cần kiểm tra model/provider."
  );
}
export async function recordRunFailure(id: string, message: string) {
  const config = await setting("routing");
  await query(
    "UPDATE agents SET healthy_since=null,failures=failures+1,run_failures=run_failures+1,error=$2,last_run_error=$2,last_run_at=now(),health=CASE WHEN run_failures+1 >= $3 THEN 'offline' ELSE health END,run_cooldown_until=CASE WHEN run_failures+1 >= $3 THEN now()+interval '30 seconds' ELSE run_cooldown_until END WHERE id=$1",
    [id, message.slice(0, 180), config.failureThreshold],
  );
}

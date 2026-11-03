import { randomUUID } from "node:crypto";
import { setting } from "./db.js";
import { decrypt } from "./security.js";

/** Direct inference only. Never forwards group data to a stateful agent gateway. */
export async function groupCompletion(
  messages: { role: string; content: string }[],
  modelOverride?: string,
) {
  const config = await setting("group_brain_model");
  if (
    !config?.enabled ||
    config.mode !== "direct-stateless" ||
    !config.model ||
    !config.secret
  )
    throw new Error(
      "Model riêng cho nhóm chưa sẵn sàng; không chuyển sang agent chung.",
    );
  const url = new URL(config.baseUrl);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname)
    )
  )
    throw new Error("Endpoint model nhóm không hợp lệ.");
  if (["8642", "8643", "18789"].includes(url.port))
    throw new Error("Không dùng agent gateway cho nhóm.");
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Endpoint model nhóm không hợp lệ.");
  const body = JSON.stringify({
    model: modelOverride?.trim() || config.model,
    messages,
    stream: false,
    max_tokens: 8000,
    store: false,
  });
  let response: Response;
  try {
    response = await fetch(url.href.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(90000),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + decrypt(config.secret),
        "Idempotency-Key": randomUUID(),
      },
      body,
    });
  } catch {
    throw new Error(
      "Model nhóm không phản hồi; không dùng agent dự phòng chung.",
    );
  }
  if (!response.ok) throw new Error(`Model nhóm lỗi HTTP ${response.status}.`);
  // Do not retain upstream errors, prompts, tool calls, or provider diagnostics in logs.
  const raw = await response.text();
  if (raw.length > 300000) throw new Error("Phản hồi model nhóm quá lớn.");
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Model nhóm trả JSON không hợp lệ.");
  }
  const choice = parsed.choices?.[0];
  if (
    parsed.error ||
    choice?.message?.tool_calls?.length ||
    choice?.finish_reason !== "stop" ||
    typeof choice?.message?.content !== "string" ||
    !choice.message.content.trim()
  )
    throw new Error("Model nhóm chưa trả kết quả hoàn chỉnh.");
  return {
    text: choice.message.content as string,
    incomplete: false,
    metrics: {
      requestBytes: Buffer.byteLength(body),
      responseBytes: Buffer.byteLength(raw),
      inputTokens: Number.isSafeInteger(parsed.usage?.prompt_tokens)
        ? parsed.usage.prompt_tokens
        : null,
      outputTokens: Number.isSafeInteger(parsed.usage?.completion_tokens)
        ? parsed.usage.completion_tokens
        : null,
    },
  };
}

export async function groupModelCatalog() {
  const config = await setting("group_brain_model");
  if (
    !config?.enabled ||
    config.mode !== "direct-stateless" ||
    !config.model ||
    !config.secret ||
    !config.baseUrl
  )
    return { models: [], error: "Model stateless cho nhóm chưa được cấu hình." };
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    return { models: [], error: "Endpoint model nhóm không hợp lệ." };
  }
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) ||
    ["8642", "8643", "18789"].includes(url.port) ||
    url.username || url.password || url.search || url.hash
  )
    return { models: [], error: "Endpoint model nhóm không hợp lệ." };
  try {
    const response = await fetch(url.href.replace(/\/$/, "") + "/models", {
      headers: { Authorization: "Bearer " + decrypt(config.secret) },
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (!response.ok)
      return { models: [], error: `Không lấy được model: HTTP ${response.status}.` };
    const payload: any = await response.json();
    const models = Array.isArray(payload.data)
      ? payload.data
          .map((item: any) => String(item?.id || "").trim())
          .filter((id: string) => id && id.length <= 200)
          .slice(0, 500)
          .map((id: string) => ({ id, label: id }))
      : [];
    if (!models.some((item: any) => item.id === config.model))
      models.unshift({ id: config.model, label: config.model + " · mặc định" });
    return { models };
  } catch {
    return { models: [], error: "Không kết nối được danh sách model nhóm." };
  }
}

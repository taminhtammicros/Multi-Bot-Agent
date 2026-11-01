import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { privateFile } from "./security.js";
import type { ChatProfile } from "./chat-profiles.js";
export const policyDir = resolve("data/command-policies");
export function scopeKey(accountId: string, kind: string, uid: string) {
  return createHash("sha256")
    .update([accountId, kind, uid].join(":"))
    .digest("hex");
}
export function needsGuard(p: ChatProfile) {
  return !p.systemCommands || !!p.deniedCommands.trim();
}
export async function writeScopePolicy(
  accountId: string,
  kind: string,
  uid: string,
  p: ChatProfile,
) {
  await mkdir(policyDir, { recursive: true, mode: 0o700 });
  const key = scopeKey(accountId, kind, uid);
  await privateFile(
    resolve(policyDir, key + ".json"),
    JSON.stringify({
      systemCommands: p.systemCommands,
      denied: p.deniedCommands
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean),
    }),
  );
  return key;
}
export async function guardStatus() {
  try {
    const ready = JSON.parse(
      await readFile(resolve(policyDir, "hermes-ready.json"), "utf8"),
    );
    if (ready.version !== 1 || ready.policyDir !== policyDir)
      return { ready: false };
    process.kill(ready.pid, 0);
    const { stdout } = await promisify(execFile)(
      "lsof",
      ["-tiTCP:8642", "-sTCP:LISTEN"],
      { timeout: 3000 },
    );
    return {
      ready: stdout.trim().split(/\s+/).includes(String(ready.pid)),
      backend: "hermes",
      pid: ready.pid,
    };
  } catch {
    return { ready: false, backend: "hermes" };
  }
}
export async function prepareGuard(
  accountId: string,
  kind: string,
  uid: string,
  p: ChatProfile,
  runId: string,
) {
  if (!(await guardStatus()).ready)
    throw Object.assign(
      new Error(
        "Bộ chặn lệnh Hermes chưa hoạt động. Cài guard trước khi tắt lệnh hệ thống hoặc dùng danh sách lệnh cấm.",
      ),
      { statusCode: 409 },
    );
  const key = await writeScopePolicy(accountId, kind, uid, p);
  const session = "zhub_" + runId.replace(/-/g, "");
  await privateFile(
    resolve(policyDir, session + ".json"),
    JSON.stringify({
      scope: key,
      accountId,
      kind,
      uid,
      token: randomBytes(32).toString("hex"),
      policyUrl: `http://127.0.0.1:${process.env.PORT || 3890}/api/tool-policy/${session}`,
      expires: Date.now() / 1000 + 900,
    }),
  );
  return session;
}

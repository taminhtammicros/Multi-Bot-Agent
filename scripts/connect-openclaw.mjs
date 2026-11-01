import "dotenv/config";
import { readFile, writeFile, mkdir, realpath, chmod } from "node:fs/promises";
import { parse as parseEnv } from "dotenv";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile),
  root = resolve("data/openclaw"),
  state = resolve(root, "state"),
  configPath = resolve(root, "openclaw.json");
const label = "com.zalo-agent-hub.openclaw",
  domain = "gui/" + process.getuid(),
  port = 18791;
const cli = (await exec("which", ["openclaw"])).stdout.trim(),
  entry = await realpath(cli);
const node = (await exec("which", ["node"])).stdout.trim();
for (const dir of [
  root,
  state,
  resolve(root, "workspace"),
  resolve(root, "logs"),
])
  await mkdir(dir, { recursive: true, mode: 0o700 });
let config;
try {
  config = JSON.parse(await readFile(configPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  const source = JSON.parse(
    await readFile(resolve(homedir(), ".openclaw/openclaw.json"), "utf8"),
  );
  const model =
    typeof source.agents?.defaults?.model === "string"
      ? source.agents.defaults.model
      : source.agents?.defaults?.model?.primary;
  const providerId = model?.split("/")[0],
    provider = source.models?.providers?.[providerId];
  if (
    !model ||
    !provider ||
    !provider.apiKey ||
    String(provider.apiKey).startsWith("$")
  )
    throw new Error(
      "Cần provider/model và credentials hiện có trong cấu hình OpenClaw local.",
    );
  config = {
    gateway: {
      mode: "local",
      port,
      bind: "loopback",
      auth: { mode: "token", token: randomBytes(32).toString("hex") },
      http: { endpoints: { chatCompletions: { enabled: true } } },
      controlUi: { enabled: false },
    },
    agents: {
      defaults: {
        model: { primary: model },
        workspace: resolve(root, "workspace"),
        skipBootstrap: true,
        maxConcurrent: 2,
      },
    },
    models: { mode: "merge", providers: { [providerId]: provider } },
    tools: {
      ...(source.tools || { profile: "coding" }),
      agentToAgent: { enabled: false },
      deny: [
        ...new Set([
          ...(source.tools?.deny || []),
          "sessions_spawn",
          "sessions_send",
          "sessions_yield",
          "subagents",
        ]),
      ],
    },
    channels: {},
    plugins: { enabled: false },
  };
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
}
await chmod(configPath, 0o600);
// The old standalone OpenClaw config can contain a stale 9Router key. Reuse
// a verified existing local credential, scoped strictly to the same endpoint.
let repairedCredential = false;
const providerId = config.agents.defaults.model.primary.split("/")[0],
  provider = config.models.providers[providerId];
if (
  ["http://localhost:20128/v1", "http://127.0.0.1:20128/v1"].includes(
    provider.baseUrl?.replace(/\/$/, ""),
  )
) {
  const verify = async (key) => {
    try {
      return (
        await fetch(provider.baseUrl.replace(/\/$/, "") + "/chat/completions", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + key,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: config.agents.defaults.model.primary.slice(
              providerId.length + 1,
            ),
            messages: [{ role: "user", content: "Reply OK." }],
            max_tokens: 1,
            stream: false,
          }),
          signal: AbortSignal.timeout(15000),
        })
      ).status;
    } catch {
      return null;
    }
  };
  if ([401, 403].includes(await verify(provider.apiKey))) {
    const env = parseEnv(
      await readFile(resolve(homedir(), ".hermes/.env"), "utf8"),
    );
    const candidate = env.HERMES_CUSTOM_LOCALHOST_20128_API_KEY;
    const candidateStatus = candidate ? await verify(candidate) : null;
    if (!candidate || !candidateStatus || [401, 403].includes(candidateStatus))
      throw new Error(
        "Khóa provider cũ không hợp lệ và chưa tìm thấy khóa local thay thế được xác thực.",
      );
    const backupDir = resolve(root, "config-backups");
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(backupDir, Date.now() + ".json"),
      JSON.stringify(config, null, 2),
      { mode: 0o600, flag: "wx" },
    );
    provider.apiKey = candidate;
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", {
      mode: 0o600,
    });
    repairedCredential = true;
  }
}
const xml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const log = resolve(root, "logs/gateway.log"),
  err = resolve(root, "logs/gateway.error.log");
for (const file of [log, err]) {
  await writeFile(file, "", { flag: "a", mode: 0o600 });
  await chmod(file, 0o600);
}
const plist = resolve(homedir(), "Library/LaunchAgents", label + ".plist");
await mkdir(resolve(homedir(), "Library/LaunchAgents"), { recursive: true });
await writeFile(
  plist,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[node, entry, "gateway", "run", "--port", String(port), "--bind", "loopback"].map((x) => "<string>" + xml(x) + "</string>").join("")}</array>
<key>WorkingDirectory</key><string>${xml(process.cwd())}</string><key>EnvironmentVariables</key><dict><key>OPENCLAW_CONFIG_PATH</key><string>${xml(configPath)}</string><key>OPENCLAW_STATE_DIR</key><string>${xml(state)}</string><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(err)}</string></dict></plist>`,
  { mode: 0o600 },
);
let loaded = false,
  previousPid;
try {
  const status = await exec("launchctl", ["print", domain + "/" + label]);
  loaded = true;
  previousPid = status.stdout.match(/\n\s*pid = (\d+)/)?.[1];
} catch {}
if (!loaded) await exec("launchctl", ["bootstrap", domain, plist]);
else if (repairedCredential)
  await exec("launchctl", ["kickstart", "-k", domain + "/" + label]);
const baseUrl = "http://127.0.0.1:" + port + "/v1";
let ready = false;
for (let i = 0; i < 45; i++) {
  try {
    if (repairedCredential && previousPid) {
      const status = await exec("launchctl", ["print", domain + "/" + label]);
      const pid = status.stdout.match(/\n\s*pid = (\d+)/)?.[1];
      if (!pid || pid === previousPid)
        throw new Error("Waiting for replacement gateway");
    }
    const health = await fetch("http://127.0.0.1:" + port + "/readyz", {
      headers: { Authorization: "Bearer " + config.gateway.auth.token },
      signal: AbortSignal.timeout(1500),
    });
    if (!health.ok || !(await health.json()).ready)
      throw new Error("Gateway is starting");
    const r = await fetch(baseUrl + "/models", {
      headers: { Authorization: "Bearer " + config.gateway.auth.token },
      signal: AbortSignal.timeout(1500),
    });
    const data = await r.json();
    if (r.ok && Array.isArray(data.data)) {
      ready = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}
if (!ready)
  throw new Error(
    "Gateway chưa sẵn sàng. Xem log riêng tư trong data/openclaw/logs.",
  );
const origin = "http://127.0.0.1:" + (process.env.PORT || 3890);
const login = await fetch(origin + "/api/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    token: (await readFile("data/admin-token", "utf8")).trim(),
  }),
});
if (!login.ok)
  throw new Error("Không đăng nhập được Hub; gateway đã sẵn sàng.");
const cookie = login.headers.get("set-cookie").split(";")[0];
const response = await fetch(origin + "/api/agents/openclaw", {
  method: "PUT",
  headers: { cookie, "Content-Type": "application/json" },
  body: JSON.stringify({
    enabled: true,
    baseUrl,
    model: "openclaw/default",
    apiKey: config.gateway.auth.token,
  }),
});
if (!response.ok) throw new Error("Không lưu được kết nối OpenClaw trong Hub.");
await fetch(origin + "/api/agents/openclaw/check", {
  method: "POST",
  headers: { cookie },
});
console.log(
  JSON.stringify({
    connected: true,
    baseUrl,
    agent: "openclaw/default",
    service: label,
    sourceModel: config.agents.defaults.model.primary,
  }),
);

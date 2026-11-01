import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { access } from "node:fs/promises";
const root = resolve("data/openclaw"),
  config = resolve(root, "openclaw.json");
await access(config);
const env = {
  ...process.env,
  OPENCLAW_CONFIG_PATH: config,
  OPENCLAW_STATE_DIR: resolve(root, "state"),
};
const exec = promisify(execFile);
const ops = [
  { path: "tools.agentToAgent.enabled", value: false },
  {
    path: "tools.deny",
    value: ["sessions_spawn", "sessions_send", "sessions_yield", "subagents"],
  },
  { path: "tools.alsoAllow", value: ["web_search", "web_fetch"] },
  { path: "plugins.enabled", value: true },
  { path: "plugins.allow", value: ["parallel"] },
  { path: "plugins.entries.parallel.enabled", value: true },
  { path: "tools.web.search.enabled", value: true },
  { path: "tools.web.search.provider", value: "parallel-free" },
];
const args = ["config", "set", "--batch-json", JSON.stringify(ops)];
await exec("openclaw", [...args, "--dry-run"], { env, timeout: 60000 });
await exec("openclaw", args, { env, timeout: 60000 });
console.log(
  "OpenClaw worker configured: synchronous tools, no nested delegation, Parallel Free web search.",
);

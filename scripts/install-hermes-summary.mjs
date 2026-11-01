import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { resolve } from "node:path";
const result = await promisify(execFile)(
  resolve(homedir(), ".hermes/hermes-agent/venv/bin/python"),
  ["scripts/setup-hermes-summary.py"],
  { timeout: 30000 },
);
process.stdout.write(result.stdout);
await import("./register-hermes-summary.mjs");

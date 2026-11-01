import { mkdir, cp, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const target = resolve(homedir(), ".hermes/plugins/zhub-policy"),
  policyDir = resolve("data/command-policies");
await mkdir(target, { recursive: true, mode: 0o700 });
await mkdir(policyDir, { recursive: true, mode: 0o700 });
await cp("integrations/hermes-guard", target, { recursive: true });
await writeFile(
  resolve(target, "connection.json"),
  JSON.stringify({ policyDir }),
  { mode: 0o600 },
);
const hermes = resolve(homedir(), ".local/bin/hermes");
await promisify(execFile)(
  hermes,
  ["plugins", "enable", "zhub-policy", "--no-allow-tool-override"],
  {
    timeout: 60000,
  },
);
console.log(
  "Hermes guard installed and enabled. Restart Hermes gateway to activate.",
);

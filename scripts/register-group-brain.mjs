import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { query, pool } from "../src/db.ts";
import { initSecrets, encrypt } from "../src/security.ts";
// Credentials remain in memory and encrypted settings; never print child output.
const program = `
import json, re
from pathlib import Path
import yaml
from dotenv import dotenv_values
root=Path.home()/'.hermes'
config=yaml.safe_load((root/'config.yaml').read_text())
m=config['model']; env=dotenv_values(root/'.env')
if m.get('provider')!='custom': raise SystemExit('A direct custom provider is required.')
key=str(m.get('api_key',''))
match=re.fullmatch(r'\\$\\{([^}]+)\\}',key)
if match: key=env.get(match.group(1),'')
base=m.get('base_url') or m.get('baseUrl') or ''
model=m.get('default') or m.get('model') or ''
if not key or not base or not model: raise SystemExit('Direct model configuration is incomplete.')
print(json.dumps({'baseUrl':base,'model':model,'key':key}))
`;
try {
  let output;
  try {
    output = await promisify(execFile)(
      resolve(homedir(), ".hermes/hermes-agent/venv/bin/python"),
      ["-c", program],
      { timeout: 10000 },
    );
  } catch {
    throw new Error(
      "Không đọc được cấu hình model trực tiếp; không thay đổi thiết lập hiện có.",
    );
  }
  const value = JSON.parse(output.stdout);
  const url = new URL(value.baseUrl);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname)
    )
  )
    throw new Error("Endpoint model phải dùng HTTPS hoặc loopback.");
  // Agent API endpoints are prohibited; use provider inference endpoint only.
  if (["8642", "8643", "18789"].includes(url.port))
    throw new Error("Không dùng agent gateway cho model nhóm.");
  await initSecrets();
  await query(
    "INSERT INTO settings(key,value) VALUES('group_brain_model',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
    [
      {
        enabled: true,
        baseUrl: value.baseUrl,
        model: value.model,
        secret: encrypt(value.key),
        mode: "direct-stateless",
      },
    ],
  );
  console.log(
    "Đã cấu hình model trực tiếp cho nhóm; không công cụ, không session agent dùng chung.",
  );
} finally {
  await pool.end();
}

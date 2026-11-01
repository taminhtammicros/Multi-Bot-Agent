import "dotenv/config";
import { mkdir, chmod, rename, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
await mkdir("backups", { recursive: true, mode: 0o700 });
const name = `backups/zalo-hub-${new Date().toISOString().replace(/[:.]/g, "-")}.dump`;
const child = spawn(
  "docker",
  [
    "compose",
    "exec",
    "-T",
    "db",
    "pg_dump",
    "-U",
    "hub",
    "-d",
    "zalo_hub",
    "-Fc",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let error = "";
child.stderr.on("data", (b) => (error += b));
const done = new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("close", (code) =>
    code === 0
      ? resolve()
      : reject(new Error(error || `pg_dump exited ${code}`)),
  );
});
try {
  await Promise.all([
    pipeline(child.stdout, createWriteStream(name + ".tmp", { mode: 0o600 })),
    done,
  ]);
  await rename(name + ".tmp", name);
  await chmod(name, 0o600);
  console.log(`Backup created: ${name}`);
} catch (e) {
  await rm(name + ".tmp", { force: true });
  throw e;
}

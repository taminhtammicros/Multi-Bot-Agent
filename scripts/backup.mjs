import "dotenv/config";
import { mkdir, chmod, rename, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
const connection = new URL(
  process.env.DATABASE_URL ||
    "postgres://hub:hub_local_dev@127.0.0.1:55439/zalo_hub",
);
if (!["postgres:", "postgresql:"].includes(connection.protocol))
  throw new Error("DATABASE_URL must use PostgreSQL");
const env = {
  ...process.env,
  PGHOST: decodeURIComponent(connection.hostname.replace(/^\[|\]$/g, "")),
  PGPORT: connection.port || "5432",
  PGDATABASE: decodeURIComponent(connection.pathname.slice(1)),
  PGUSER: decodeURIComponent(connection.username),
  PGPASSWORD: decodeURIComponent(connection.password),
};
for (const [parameter, variable] of [
  ["sslmode", "PGSSLMODE"],
  ["sslrootcert", "PGSSLROOTCERT"],
  ["sslcert", "PGSSLCERT"],
  ["sslkey", "PGSSLKEY"],
  ["connect_timeout", "PGCONNECT_TIMEOUT"],
]) {
  const value = connection.searchParams.get(parameter);
  if (value) env[variable] = value;
}
await mkdir("backups", { recursive: true, mode: 0o700 });
const name = `backups/zalo-hub-${new Date().toISOString().replace(/[:.]/g, "-")}.dump`;
const child = spawn(
  "pg_dump",
  [
    "--format=custom",
    "--no-owner",
    "--no-privileges",
  ],
  { env, stdio: ["ignore", "pipe", "pipe"] },
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

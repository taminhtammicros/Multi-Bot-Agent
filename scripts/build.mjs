import { spawnSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";

const result = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);

await mkdir("dist", { recursive: true });
await Promise.all(
  ["schema.sql", "group-brain.sql"].map((file) =>
    copyFile(`src/${file}`, `dist/${file}`),
  ),
);

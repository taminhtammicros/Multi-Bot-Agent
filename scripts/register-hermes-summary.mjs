import "dotenv/config";
import { readFile } from "node:fs/promises";
import { parse } from "dotenv";
import { query, pool } from "../src/db.ts";
import { initSecrets, encrypt } from "../src/security.ts";
const endpoint = JSON.parse(
  await readFile("data/hermes-summary/endpoint.json", "utf8"),
);
const env = parse(await readFile("data/hermes-summary/.env", "utf8"));
try {
  let body, response;
  for (let i = 0; i < 30; i++) {
    try {
      response = await fetch(endpoint.baseUrl + "/toolsets", {
        headers: { Authorization: "Bearer " + env.API_SERVER_KEY },
        signal: AbortSignal.timeout(2000),
      });
      body = await response.json();
      if (response.ok && Array.isArray(body.data)) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (
    !response?.ok ||
    !Array.isArray(body?.data) ||
    body.data.some((t) => typeof t.enabled !== "boolean" || t.enabled)
  )
    throw new Error("Summary service must expose zero enabled toolsets.");
  await initSecrets();
  await query(
    "INSERT INTO settings(key,value) VALUES('hermes_synthesis',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
    [
      {
        enabled: true,
        baseUrl: endpoint.baseUrl,
        model: endpoint.model,
        mainAlias: endpoint.mainAlias,
        secret: encrypt(env.API_SERVER_KEY),
      },
    ],
  );
  console.log(
    JSON.stringify({
      registered: true,
      baseUrl: endpoint.baseUrl,
      enabledToolsets: 0,
    }),
  );
} finally {
  await pool.end();
}

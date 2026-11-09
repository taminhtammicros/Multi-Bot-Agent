import pg from "pg";
import { readFile } from "node:fs/promises";
export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgres://hub:hub_local_dev@127.0.0.1:55439/zalo_hub",
  max: 10,
});
export const query = (sql: string, args: unknown[] = []) =>
  pool.query(sql, args);
export async function migrate() {
  // Preserve data from the earlier pair-only bridge before creating the
  // expanded room schema, whose channel_bridges columns have a new meaning.
  await query(`DO $$ BEGIN
    IF to_regclass('public.channel_bridges') IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='channel_bridges' AND column_name='account_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='channel_bridges' AND column_name='zalo_account_id')
       AND to_regclass('public.channel_bridges_legacy') IS NULL THEN
      ALTER TABLE channel_bridges RENAME TO channel_bridges_legacy;
    END IF;
  END $$`);
  await query(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      await readFile(new URL("./channel-relay.sql", import.meta.url), "utf8"),
    );
    await client.query(
      await readFile(new URL("./bridge-network.sql", import.meta.url), "utf8"),
    );
    await client.query(
      await readFile(new URL("./group-brain.sql", import.meta.url), "utf8"),
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function setting<T = any>(key: string): Promise<T> {
  return (await query("SELECT value FROM settings WHERE key=$1", [key])).rows[0]
    ?.value;
}
export async function event(kind: string, message: string) {
  await query("INSERT INTO events(kind,message) VALUES($1,$2)", [
    kind,
    message,
  ]);
}

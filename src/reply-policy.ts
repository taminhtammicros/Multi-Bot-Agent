import { pool, query } from "./db.js";
import { getZaloPolicy } from "./zalo-policy.js";
export type ReplyMode = "mention" | "silent" | "all";
export type ChatKind = "dm" | "group";
export const modeLabels: Record<ReplyMode, string> = {
  mention: "Tag mới trả lời",
  silent: "Im lặng",
  all: "Hóng chuyện",
};
export function isBotMentioned(message: any, botId: string | null) {
  return (
    !!botId &&
    Array.isArray(message.data?.mentions) &&
    message.data.mentions.some((mention: any) => String(mention?.uid) === botId)
  );
}
export function permitsReply(mode: ReplyMode, mentioned: boolean) {
  return mode === "all" || (mode === "mention" && mentioned);
}
export async function replyMode(
  accountId: string | null,
  kind: ChatKind,
  uid: string,
  policy?: any,
): Promise<ReplyMode> {
  const cfg = policy || (await getZaloPolicy(accountId));
  const allowed =
    kind === "group"
      ? cfg.groupsEnabled && cfg.allowGroups.includes(uid)
      : cfg.allowUsers.includes(uid);
  if (!allowed) return "silent";
  if (!accountId) return "all";
  return (
    (
      await query(
        "SELECT mode FROM zalo_reply_rules WHERE account_id=$1 AND kind=$2 AND uid=$3",
        [accountId, kind, uid],
      )
    ).rows[0]?.mode || "all"
  );
}
export async function setReplyMode(
  accountId: string,
  kind: ChatKind,
  uid: string,
  mode: ReplyMode,
) {
  if (kind === "dm" && accountId === uid)
    throw Object.assign(
      new Error("Không thể cấp quyền DM cho chính tài khoản bot"),
      { statusCode: 400 },
    );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO zalo_account_policies(account_id,policy) VALUES($1,$2) ON CONFLICT(account_id) DO NOTHING",
      [accountId, { allowUsers: [], allowGroups: [], groupsEnabled: false }],
    );
    const policy = (
      await client.query(
        "SELECT policy FROM zalo_account_policies WHERE account_id=$1 FOR UPDATE",
        [accountId],
      )
    ).rows[0].policy;
    const key = kind === "group" ? "allowGroups" : "allowUsers",
      ids = new Set<string>(policy[key]);
    if (mode === "silent") ids.delete(uid);
    else ids.add(uid);
    if (ids.size > 500)
      throw Object.assign(
        new Error("Danh sách cho phép tối đa 500 ID mỗi loại"),
        { statusCode: 400 },
      );
    policy[key] = [...ids];
    await client.query(
      "UPDATE zalo_account_policies SET policy=$2,reviewed_at=now(),updated_at=now() WHERE account_id=$1",
      [accountId, policy],
    );
    await client.query(
      "INSERT INTO zalo_reply_rules(account_id,kind,uid,mode) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,kind,uid) DO UPDATE SET mode=EXCLUDED.mode,updated_at=now()",
      [accountId, kind, uid, mode],
    );
    if (kind === "dm")
      await client.query(
        "INSERT INTO zalo_contacts(account_id,uid,last_seen,message_count) VALUES($1,$2,null,0) ON CONFLICT DO NOTHING",
        [accountId, uid],
      );
    else
      await client.query(
        "INSERT INTO zalo_groups(account_id,group_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [accountId, uid],
      );
    await client.query("INSERT INTO events(kind,message) VALUES($1,$2)", [
      "zalo_reply_mode",
      `${kind} ${uid}: ${modeLabels[mode]} (bot ${accountId})`,
    ]);
    await client.query("COMMIT");
    return {
      ok: true,
      uid,
      kind,
      mode,
      allowed: mode !== "silent",
      groupsEnabled: policy.groupsEnabled,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
/** Legacy bulk allowlist editor preserves modes of unchanged entries. */
export async function replaceZaloPolicy(accountId: string, policy: any) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO zalo_account_policies(account_id,policy) VALUES($1,$2) ON CONFLICT(account_id) DO NOTHING",
      [accountId, { allowUsers: [], allowGroups: [], groupsEnabled: false }],
    );
    const old = (
      await client.query(
        "SELECT policy FROM zalo_account_policies WHERE account_id=$1 FOR UPDATE",
        [accountId],
      )
    ).rows[0].policy;
    for (const [kind, key] of [
      ["dm", "allowUsers"],
      ["group", "allowGroups"],
    ]) {
      const previous = new Set<string>(old[key]),
        next = new Set<string>(policy[key]);
      for (const uid of new Set([...previous, ...next])) {
        if (previous.has(uid) === next.has(uid)) continue;
        const mode = next.has(uid)
          ? kind === "group"
            ? "mention"
            : "all"
          : "silent";
        await client.query(
          "INSERT INTO zalo_reply_rules(account_id,kind,uid,mode) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,kind,uid) DO UPDATE SET mode=EXCLUDED.mode,updated_at=now()",
          [accountId, kind, uid, mode],
        );
      }
    }
    await client.query(
      "UPDATE zalo_account_policies SET policy=$2,reviewed_at=now(),updated_at=now() WHERE account_id=$1",
      [accountId, policy],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

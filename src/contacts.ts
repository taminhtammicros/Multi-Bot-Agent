import { setReplyMode } from "./reply-policy.js";
import { pool, query } from "./db.js";
import { getZaloPolicy, saveZaloPolicyPatch } from "./zalo-policy.js";
export async function observeContact(
  accountId: string,
  uid: string,
  name: string,
) {
  if (
    !/^\d{1,30}$/.test(accountId) ||
    !/^\d{1,30}$/.test(uid) ||
    accountId === uid
  )
    return;
  await query(
    `INSERT INTO zalo_contacts(account_id,uid,display_name) VALUES($1,$2,$3)
 ON CONFLICT(account_id,uid) DO UPDATE SET display_name=CASE WHEN EXCLUDED.display_name='' THEN zalo_contacts.display_name ELSE EXCLUDED.display_name END,last_seen=now(),message_count=zalo_contacts.message_count+1`,
    [accountId, uid, name.slice(0, 200)],
  );
}
export async function listContacts(accountId: string | null) {
  const policy = await getZaloPolicy(accountId);
  const rows = accountId
    ? (
        await query(
          "SELECT uid,display_name,first_seen,last_seen,message_count::int FROM zalo_contacts WHERE account_id=$1 ORDER BY last_seen DESC LIMIT 500",
          [accountId],
        )
      ).rows
    : [];
  const contacts = new Map(
    rows.map((row) => [
      row.uid,
      { ...row, kind: "dm", allowed: policy.allowUsers.includes(row.uid) },
    ]),
  );
  for (const uid of policy.allowUsers)
    if (!contacts.has(uid))
      contacts.set(uid, {
        uid,
        kind: "dm",
        display_name: "",
        first_seen: null,
        last_seen: null,
        message_count: 0,
        allowed: true,
      });
  const groupData = await listGroupContacts(accountId);
  const rules = accountId
    ? (
        await query(
          "SELECT kind,uid,mode FROM zalo_reply_rules WHERE account_id=$1",
          [accountId],
        )
      ).rows
    : [];
  const modes = new Map(rules.map((r) => [r.kind + ":" + r.uid, r.mode]));
  const combined = [...contacts.values(), ...groupData.groups].map((c) => {
    const mode = c.allowed
      ? modes.get(c.kind + ":" + c.uid) || "all"
      : "silent";
    return {
      ...c,
      // OpenClaw conversation refs are opaque Gateway-issued IDs. The Zalo
      // channel currently belongs to this Hub, so there is no OpenClaw ref.
      conversationRef: null,
      mode,
      allowed: c.allowed && mode !== "silent",
      effective:
        c.allowed &&
        mode !== "silent" &&
        (c.kind === "dm" || groupData.groupsEnabled),
    };
  });
  return {
    accountId,
    contacts: combined,
    groupsEnabled: groupData.groupsEnabled,
    policyConfigured: groupData.policyConfigured,
    legacyPolicyAvailable: groupData.legacyPolicyAvailable,
  };
}
export async function setContactAccess(
  accountId: string,
  uid: string,
  allowed: boolean,
) {
  return setReplyMode(accountId, "dm", uid, allowed ? "all" : "silent");
}

export async function observeGroup(
  accountId: string,
  groupId: string,
  name = "",
  message = false,
  memberCount?: number,
) {
  if (!/^\d{1,30}$/.test(accountId) || !/^\d{1,30}$/.test(groupId)) return;
  await query(
    `INSERT INTO zalo_groups(account_id,group_id,display_name,last_seen,message_count,member_count)
 VALUES($1,$2,$3,CASE WHEN $4 THEN now() ELSE null END,CASE WHEN $4 THEN 1 ELSE 0 END,$5)
 ON CONFLICT(account_id,group_id) DO UPDATE SET display_name=CASE WHEN EXCLUDED.display_name='' THEN zalo_groups.display_name ELSE EXCLUDED.display_name END,
 observed_at=now(),last_seen=CASE WHEN $4 THEN now() ELSE zalo_groups.last_seen END,message_count=zalo_groups.message_count+CASE WHEN $4 THEN 1 ELSE 0 END,member_count=COALESCE(EXCLUDED.member_count,zalo_groups.member_count)`,
    [
      accountId,
      groupId,
      name.slice(0, 200),
      message,
      Number.isSafeInteger(memberCount) ? memberCount : null,
    ],
  );
}
export async function listGroupContacts(accountId: string | null) {
  const policy = await getZaloPolicy(accountId);
  const rows = accountId
    ? (
        await query(
          "SELECT group_id AS uid,display_name,first_seen,last_seen,observed_at,message_count::int,member_count FROM zalo_groups WHERE account_id=$1 ORDER BY observed_at DESC LIMIT 500",
          [accountId],
        )
      ).rows
    : [];
  const groups = new Map(
    rows.map((row) => [
      row.uid,
      {
        ...row,
        kind: "group",
        allowed: policy.allowGroups.includes(row.uid),
        effective: policy.groupsEnabled && policy.allowGroups.includes(row.uid),
      },
    ]),
  );
  for (const uid of policy.allowGroups)
    if (!groups.has(uid))
      groups.set(uid, {
        uid,
        kind: "group",
        display_name: "",
        last_seen: null,
        observed_at: null,
        message_count: 0,
        allowed: true,
        effective: policy.groupsEnabled,
        member_count: null,
        first_seen: null,
      });
  return {
    groupsEnabled: policy.groupsEnabled,
    policyConfigured: policy.policyConfigured,
    legacyPolicyAvailable: policy.legacyPolicyAvailable,
    groups: [...groups.values()],
  };
}
export async function setGroupAccess(
  accountId: string,
  uid: string,
  allowed: boolean,
) {
  return setReplyMode(
    accountId,
    "group",
    uid,
    allowed ? "mention" : "silent",
  );
}

export async function setGroupsEnabled(accountId: string, enabled: boolean) {
  await saveZaloPolicyPatch(accountId, { groupsEnabled: enabled });
  await query("INSERT INTO events(kind,message) VALUES($1,$2)", [
    "zalo_access",
    `${enabled ? "Bật" : "Tắt"} phản hồi nhóm cho bot ${accountId}`,
  ]);
  return { ok: true, groupsEnabled: enabled };
}

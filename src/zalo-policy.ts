import { query, setting } from "./db.js";

export type ZaloPolicy = {
  allowUsers: string[];
  allowGroups: string[];
  groupsEnabled: boolean;
  policyConfigured: boolean;
  legacyPolicyAvailable: boolean;
};

const empty = (): ZaloPolicy => ({
  allowUsers: [],
  allowGroups: [],
  groupsEnabled: false,
  policyConfigured: false,
  legacyPolicyAvailable: false,
});

export async function getZaloPolicy(accountId: string | null): Promise<ZaloPolicy> {
  if (!accountId) return empty();
  const row = (
    await query(
      "SELECT policy,reviewed_at FROM zalo_account_policies WHERE account_id=$1",
      [accountId],
    )
  ).rows[0];
  const current = row?.policy || empty();
  const legacy = await setting<any>("zalo");
  const legacyPolicyAvailable = Boolean(
    !row?.reviewed_at &&
      ((legacy?.allowUsers || []).length ||
        (legacy?.allowGroups || []).length ||
        legacy?.groupsEnabled),
  );
  return {
    ...empty(),
    ...current,
    policyConfigured: Boolean(row?.reviewed_at),
    legacyPolicyAvailable,
  };
}

export async function saveZaloPolicy(accountId: string, policy: Omit<ZaloPolicy, "policyConfigured" | "legacyPolicyAvailable">) {
  await query(
    `INSERT INTO zalo_account_policies(account_id,policy,reviewed_at,updated_at)
     VALUES($1,$2,now(),now())
     ON CONFLICT(account_id) DO UPDATE SET policy=EXCLUDED.policy,reviewed_at=now(),updated_at=now()`,
    [
      accountId,
      {
        allowUsers: [...new Set(policy.allowUsers)],
        allowGroups: [...new Set(policy.allowGroups)],
        groupsEnabled: Boolean(policy.groupsEnabled),
      },
    ],
  );
}

export async function saveZaloPolicyPatch(
  accountId: string,
  patch: Partial<Pick<ZaloPolicy, "allowUsers" | "allowGroups" | "groupsEnabled">>,
) {
  const current = await getZaloPolicy(accountId);
  await saveZaloPolicy(accountId, {
    allowUsers: patch.allowUsers ?? current.allowUsers,
    allowGroups: patch.allowGroups ?? current.allowGroups,
    groupsEnabled: patch.groupsEnabled ?? current.groupsEnabled,
  });
}

export async function claimZaloSetupNotification(accountId: string) {
  const result = await query(
    `INSERT INTO zalo_account_policies(account_id,policy,setup_notified_at,updated_at)
     VALUES($1,$2,now(),now())
     ON CONFLICT(account_id) DO UPDATE SET setup_notified_at=now(),updated_at=now()
       WHERE zalo_account_policies.setup_notified_at IS NULL
     RETURNING account_id`,
    [accountId, { allowUsers: [], allowGroups: [], groupsEnabled: false }],
  );
  return Boolean(result.rowCount);
}

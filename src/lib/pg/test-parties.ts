import { newUlid } from './ulid';
import type { WithTx } from './with-tx';

// 測試用的 party 種子（MIL-187）。收款帳戶的 holder_party_id 掛了 control.parties 的外鍵，
// 持有人也必須在組織成員或案件成員清單內，所以寫收款帳戶的測試要先有真實的 party。
// 用 app_rw 寫入：control.parties、users、org_memberships 對 app_rw 開放 INSERT，case_members 走組織脈絡。

/** 建立一個 party。email 由 ID 衍生，所以不會撞號。 */
export async function seedParty(withTx: WithTx, orgId: string, displayName = '測試持有人'): Promise<string> {
  const id = newUlid();
  await withTx({ kind: 'org', orgId }, (tx) =>
    tx.query('INSERT INTO control.parties (id, email, display_name) VALUES ($1, $2, $3)', [id, `${id.toLowerCase()}@example.com`, displayName]),
  );
  return id;
}

/** 建立一個 party，並加為這個組織的成員。回傳 party ID。 */
export async function seedOrgMember(
  withTx: WithTx,
  orgId: string,
  displayName = '測試成員',
  role: 'admin' | 'staff' | 'viewer' = 'staff',
): Promise<string> {
  const partyId = await seedParty(withTx, orgId, displayName);
  await withTx({ kind: 'org', orgId }, async (tx) => {
    const userId = newUlid();
    await tx.query('INSERT INTO control.users (id, party_id) VALUES ($1, $2)', [userId, partyId]);
    await tx.query('INSERT INTO control.org_memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, $4)', [newUlid(), orgId, userId, role]);
  });
  return partyId;
}

/** 把已存在的 party 加為案件成員。案件要先存在（seedCases）。回傳 party ID。 */
export async function seedCaseMember(
  withTx: WithTx,
  orgId: string,
  caseId: string,
  partyId: string,
  options: { relation?: string; ended?: boolean } = {},
): Promise<string> {
  await withTx({ kind: 'org', orgId }, (tx) =>
    tx.query(
      options.ended
        ? `INSERT INTO org.case_members (id, org_id, case_id, party_id, relation, valid_period)
           VALUES ($1, $2, $3, $4, $5, tstzrange(now() - interval '2 days', now() - interval '1 day', '[)'))`
        : `INSERT INTO org.case_members (id, org_id, case_id, party_id, relation) VALUES ($1, $2, $3, $4, $5)`,
      [newUlid(), orgId, caseId, partyId, options.relation ?? 'lessee'],
    ),
  );
  return partyId;
}

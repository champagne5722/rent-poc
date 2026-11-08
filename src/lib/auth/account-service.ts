import type { ControlTx } from '../pg/with-tx';
import { newUlid } from '../pg/ulid';
import { bootstrapGrants } from './bootstrap';
import { displayNameFromEmail } from './email';

// 帳號與可用身分（control.parties、users、org_memberships）。都在 control 脈絡的交易內呼叫。

export interface Account {
  userId: string;
  partyId: string;
  displayName: string;
}

/**
 * 通過驗證碼的 email 找或建帳號（party 與 user）。帳號第一次建立時，補上環境變數指定的成員資格。
 * party 可能早就存在：承租人在登入前，送簽時就會依 email 建 party（MIL-115）。
 * 沒有任何成員資格的帳號照樣建立，session 的身分為空，建組織的流程由 MIL-106 接手。
 */
export async function provisionAccount(
  tx: ControlTx,
  input: { email: string; now: Date; env: Readonly<Record<string, string | undefined>> },
): Promise<Account> {
  const { email, now, env } = input;
  const at = now.toISOString();

  // 並發的第一次登入不得建出兩個 party：UNIQUE(email) 會擋，ON CONFLICT 讓第二個請求直接沿用
  await tx.query(
    `INSERT INTO control.parties (id, email, display_name, created_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO NOTHING`,
    [newUlid(), email, displayNameFromEmail(email), at],
  );
  const party = await tx.query<{ id: string; display_name: string }>(
    'SELECT id, display_name FROM control.parties WHERE email = $1',
    [email],
  );
  const partyId = party.rows[0].id;

  // 只有帳號第一次建立時才補環境變數指定的成員資格。之後 admin 把這個帳號移出組織是有效的，
  // 不得在下次登入時又被加回來（ADR-0022 決議 2）。所以 SEED_OWNER_EMAIL 必須在該帳號第一次登入前設定
  const created = await tx.query<{ id: string }>(
    `INSERT INTO control.users (id, party_id, created_at) VALUES ($1, $2, $3)
     ON CONFLICT (party_id) DO NOTHING RETURNING id`,
    [newUlid(), partyId, at],
  );
  let userId = created.rows[0]?.id;
  if (userId) {
    for (const grant of bootstrapGrants(email, env)) {
      await tx.query(
        `INSERT INTO control.org_memberships (id, org_id, user_id, role, created_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (org_id, user_id) DO NOTHING`,
        [newUlid(), grant.orgId, userId, grant.role, at],
      );
    }
  } else {
    userId = (await tx.query<{ id: string }>('SELECT id FROM control.users WHERE party_id = $1', [partyId])).rows[0].id;
  }
  return { userId, partyId, displayName: party.rows[0].display_name };
}

/** session 記下的目前身分。null 代表帳號還沒有任何可用身分。 */
export type SessionIdentity = { kind: 'org'; orgId: string } | { kind: 'party' } | { kind: 'operator' } | null;

/**
 * 外部事實的接點。承租人身分要有案件成員關係才成立，案件表由 MIL-115 建立，MIL-121 接上真實查詢。
 * 在那之前預設為 false：沒有人能以承租人身分登入，也不會有 party 脈絡的 session 通過重查。
 */
export interface IdentityFacts {
  partyHasCaseMembership(tx: ControlTx, partyId: string): Promise<boolean>;
}

export const defaultIdentityFacts: IdentityFacts = {
  partyHasCaseMembership: async () => false,
};

/**
 * 帳號目前可用的身分，依序：屋主與執業主體組織（先加入的在前）、承租人、平台營運者。
 * 平台組織的成員是 operator，不是 org（ADR-0022 決議 6）。第一個就是登入後的預設身分。
 */
export async function listIdentities(
  tx: ControlTx,
  account: Pick<Account, 'userId' | 'partyId'>,
  facts: IdentityFacts = defaultIdentityFacts,
): Promise<NonNullable<SessionIdentity>[]> {
  const { rows } = await tx.query<{ org_id: string; kind: string }>(
    `SELECT m.org_id, o.kind
       FROM control.org_memberships m JOIN control.orgs o ON o.id = m.org_id
      WHERE m.user_id = $1 ORDER BY m.created_at, m.id`,
    [account.userId],
  );
  const identities: NonNullable<SessionIdentity>[] = rows
    .filter((r) => r.kind !== 'platform')
    .map((r) => ({ kind: 'org', orgId: r.org_id }));
  if (await facts.partyHasCaseMembership(tx, account.partyId)) identities.push({ kind: 'party' });
  if (rows.some((r) => r.kind === 'platform')) identities.push({ kind: 'operator' });
  return identities;
}

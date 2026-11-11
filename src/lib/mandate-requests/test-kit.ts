import { NextRequest } from 'next/server';
import { expect } from 'vitest';
import { SESSION_COOKIE } from '../auth/config';
import { resolveRequestContext } from '../auth/login-flow';
import { createOwnerOrg } from '../orgs/onboarding';
import { actAsContext, nextAnchorKey } from '../pg/route-test-kit';
import { setupPracticeKit, type Account, type PracticeKit } from '../practice-entities/test-kit';

// MIL-206 的測試工具：真的 migration、PGlite 的 app_rw 連線、本機 FileStore、真實的登入流程。
// 業者的組織用 createPracticeOrg 建，業別用 app_owner 改成已驗證（營運者核對的流程由 MIL-109 的測試涵蓋）。
// 屋主用真實的 email 驗證碼登入，再用 createOwnerOrg 建組織。

export { setupPracticeKit, type Account, type PracticeKit };

export const T_BASE = new Date();

export async function verifyLicenses(pk: PracticeKit, orgId: string, kinds: readonly string[] = ['management', 'master_lease']): Promise<void> {
  await pk.kit.asOwner((db) =>
    db.query(
      `UPDATE registry.practice_licenses SET state = 'verified', updated_at = now()
        WHERE kind = ANY ($2::text[]) AND entity_id = (SELECT id FROM registry.practice_entities WHERE org_id = $1)`,
      [orgId, kinds],
    ),
  );
}

let taxSeq = 0;

/** 業者帳號：一個執業主體組織，指定的業別已驗證。taxId 每次不同，同一個測試可建多家業者。 */
export async function verifiedPractice(
  pk: PracticeKit,
  email: string,
  options: { kinds?: readonly string[]; verified?: readonly string[]; name?: string } = {},
): Promise<Account> {
  const kinds = options.kinds ?? ['management', 'master_lease'];
  taxSeq += 1;
  const account = await pk.practiceAccount(email, {
    name: options.name ?? `安心代管有限公司${taxSeq}`,
    taxId: String(10000000 + taxSeq),
    kinds,
  });
  await verifyLicenses(pk, account.orgId, options.verified ?? kinds);
  return account;
}

export interface OwnerAccount {
  token: string;
  orgId: string;
  partyId: string;
  userId: string;
  email: string;
}

/** 屋主帳號：登入後建屋主的組織。 */
export async function ownerAccount(pk: PracticeKit, email: string, name = '王先生'): Promise<OwnerAccount> {
  const { token } = await pk.login(email);
  const result = await createOwnerOrg(token, { name }, { now: pk.deps.now() });
  if (result.status !== 'ok') throw new Error(`建屋主組織失敗：${JSON.stringify(result)}`);
  return resolveOwner(pk, token, email);
}

export async function resolveOwner(pk: PracticeKit, token: string, email: string): Promise<OwnerAccount> {
  const rc = await resolveRequestContext(token, pk.deps.now(), 'test');
  if (rc.kind !== 'org') throw new Error('建完組織後應該是組織身分');
  return { token, orgId: rc.orgId, partyId: rc.partyId, userId: rc.userId, email };
}

/** 讓 route 看到的請求脈絡是這個帳號。 */
export function actAsAccount(account: { orgId: string; partyId: string; userId: string }, orgKind: 'owner' | 'practice', role: 'admin' | 'staff' | 'viewer' = 'admin'): void {
  actAsContext({ kind: 'org', orgId: account.orgId, orgKind, userId: account.userId, partyId: account.partyId, role, requestId: 'test' });
}

export const json = (res: Response) => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const jsonRequest = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
  });

export const cookieOf = (token: string): Record<string, string> => ({ cookie: `${SESSION_COOKIE}=${token}` });

/** 代填資料的範例：真實的縣市、鄉鎮市區、段小段（臺北市大安區 龍泉 一），建號每次不同。 */
export function sampleDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '大安區溫馨兩房',
    address: '台北市大安區和平東路二段 100 號 3 樓',
    equipment: [],
    anchor: { key: nextAnchorKey() },
    ...overrides,
  };
}

export function expectSameResponse(a: { status: number; text: string; headers: Record<string, string> }, b: typeof a): void {
  expect(a.status).toBe(b.status);
  expect(a.text).toBe(b.text);
  expect(a.headers).toEqual(b.headers);
}

/** 把回應壓成可逐位元比對的形狀：狀態碼、本文原文、標頭。 */
export async function snapshot(res: Response): Promise<{ status: number; text: string; headers: Record<string, string> }> {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: res.status, text: await res.text(), headers };
}

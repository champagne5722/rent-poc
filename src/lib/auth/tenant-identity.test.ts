import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findOrCreateParty } from '../case-store';
import { createMockMailer, type MockMailer } from '../mailer/mock-mailer';
import { withTx } from '../pg/database';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import { newUlid } from '../pg/ulid';
import { PLATFORM_ORG_ID } from './config';
import { completeLogin, listSessionIdentities, requestLoginCode, resolveRequestContext, type LoginDeps } from './login-flow';

// 承租人身分（MIL-121，ADR-0022 決議 6）：email 對應的 party 是任何案件的有效承租人或共同承租人時，
// 登入後有「承租人」身分，落地 /tenant。連線是 PGlite 的 app_rw，RLS 與權限都生效。

let kit: RouteDb;
let mailer: MockMailer;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());

const T0 = new Date('2026-11-09T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

beforeEach(async () => {
  await kit.reset();
  mailer = createMockMailer();
});

const deps = (over: Partial<LoginDeps> = {}): LoginDeps => ({ now: T0, secret: 'test-secret', mailer, env: {}, ...over });

function lastCode(): string {
  const match = mailer.sent.at(-1)?.text.match(/\d{6}/);
  if (!match) throw new Error('沒有寄出驗證碼');
  return match[0];
}

async function loginAs(email: string) {
  expect(await requestLoginCode(email, deps())).toEqual({ status: 'sent' });
  const result = await completeLogin(email, lastCode(), deps());
  if (result.status !== 'ok') throw new Error('登入失敗');
  return result;
}

/** 在 orgA 建一個案件，並把這個 email 加成指定關係的成員。回傳 { caseId, partyId }。 */
async function seedMember(email: string, relation: 'lessee' | 'co_lessee' | 'lessor', caseId = newUlid()) {
  return withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => {
    await tx.query(
      `INSERT INTO org.cases (id, org_id, kind, state, business_type, title) VALUES ($1, $2, 'lease', 'active', 'self_managed', '測試案件')
       ON CONFLICT (id) DO NOTHING`,
      [caseId, kit.orgA],
    );
    const partyId = await findOrCreateParty(tx, email, '測試');
    await tx.query(`INSERT INTO org.case_members (id, org_id, case_id, party_id, relation) VALUES ($1, $2, $3, $4, $5)`, [
      newUlid(),
      kit.orgA,
      caseId,
      partyId,
      relation,
    ]);
    return { caseId, partyId };
  });
}

async function platformAudit() {
  return withTx({ kind: 'org', orgId: PLATFORM_ORG_ID }, async (tx) => {
    const { rows } = await tx.query<{ action: string }>('SELECT action FROM audit.events ORDER BY seq');
    return rows.map((r) => r.action);
  });
}

describe('承租人身分的成立條件', () => {
  it('承租人：登入後身分是 party，落地 /tenant，requestContext 是 party 脈絡', async () => {
    const { partyId } = await seedMember('tenant@example.com', 'lessee');
    const result = await loginAs('tenant@example.com');
    expect(result.identity).toEqual({ kind: 'party' });
    expect(result.landing).toBe('/tenant');
    const rc = await resolveRequestContext(result.token, at(1000), 'r1');
    expect(rc).toMatchObject({ kind: 'party', partyId });
  });

  it('共同承租人也有承租人身分', async () => {
    await seedMember('co@example.com', 'co_lessee');
    expect((await loginAs('co@example.com')).identity).toEqual({ kind: 'party' });
  });

  it('只是出租人的 party 沒有承租人身分：登入後沒有任何身分', async () => {
    await seedMember('lessor@example.com', 'lessor');
    const result = await loginAs('lessor@example.com');
    expect(result.identity).toBeNull();
    await expect(resolveRequestContext(result.token, at(1000), 'r')).rejects.toMatchObject({ reason: 'no_identity' });
  });

  it('email 不屬於任何案件：沒有任何身分', async () => {
    const result = await loginAs('nobody@example.com');
    expect(result.identity).toBeNull();
  });

  it('身分切換器列出「承租人」', async () => {
    await seedMember('tenant@example.com', 'lessee');
    const result = await loginAs('tenant@example.com');
    const list = await listSessionIdentities(result.token, at(1000));
    expect(list?.options.map((o) => o.label)).toEqual(['承租人']);
    expect(list?.current?.kind).toBe('party');
  });

  it('同時是屋主組織成員與承租人：預設身分是組織，切換器有兩個選項，不自動落地 /tenant', async () => {
    await seedMember('both@example.com', 'lessee');
    const result = await loginAs('both@example.com');
    expect(result.identity).toEqual({ kind: 'party' }); // 還沒有組織身分時，預設身分是承租人
    // 加進屋主組織後，組織排在前面
    await kit.asOwner(async (db) => {
      const { rows } = await db.query<{ id: string }>(`SELECT id FROM control.users LIMIT 1`);
      await db.query(`INSERT INTO control.org_memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, 'admin')`, [newUlid(), kit.orgA, rows[0].id]);
    });
    const again = await completeLogin('both@example.com', (await requestAgain('both@example.com')), deps({ now: at(120_000) }));
    if (again.status !== 'ok') throw new Error('登入失敗');
    expect(again.identity).toEqual({ kind: 'org', orgId: kit.orgA });
    expect(again.landing).toBe('/'); // 組織與承租人並存：維持工作台，由切換器選，不自動進 /tenant
    const list = await listSessionIdentities(again.token, at(121_000));
    expect(list?.options.map((o) => o.kind)).toEqual(['owner', 'party']);
  });
});

async function requestAgain(email: string): Promise<string> {
  expect(await requestLoginCode(email, deps({ now: at(120_000) }))).toEqual({ status: 'sent' });
  return lastCode();
}

describe('驗證碼通過之前不洩漏 email 有沒有案件（P0-21 AC6）', () => {
  it('寄驗證碼與輸錯驗證碼的回應，有案件與沒有案件的 email 完全相同', async () => {
    await seedMember('has@example.com', 'lessee');
    const sentA = await requestLoginCode('has@example.com', deps());
    const sentB = await requestLoginCode('none@example.com', deps());
    expect(sentA).toEqual(sentB);
    const wrongA = await completeLogin('has@example.com', '000000', deps());
    const wrongB = await completeLogin('none@example.com', '000000', deps());
    expect(wrongA).toEqual(wrongB);
  });
});

describe('承租人成員資格失效後的下一個請求（P0-21 AC5）', () => {
  it('成員列關閉後，已登入的 session 立即失效，session 被刪並寫 auth.membership_rejected', async () => {
    const { caseId, partyId } = await seedMember('tenant@example.com', 'lessee');
    const result = await loginAs('tenant@example.com');
    expect(await resolveRequestContext(result.token, at(1000), 'r1')).toMatchObject({ kind: 'party' });

    // 成員列的有效期在過去結束（模擬出租人更新 email 之後）
    await withTx({ kind: 'org', orgId: kit.orgA }, (tx) =>
      tx.query(
        `UPDATE org.case_members SET valid_period = tstzrange(lower(valid_period) - interval '1 day', now() - interval '1 second', '[)')
          WHERE case_id = $1 AND party_id = $2`,
        [caseId, partyId],
      ),
    );
    await expect(resolveRequestContext(result.token, at(2000), 'r2')).rejects.toMatchObject({ reason: 'membership_lost' });
    expect(await platformAudit()).toContain('auth.membership_rejected');
    // session 已刪，再用同一個 token 是 no_session
    await expect(resolveRequestContext(result.token, at(3000), 'r3')).rejects.toMatchObject({ reason: 'no_session' });
  });

  it('還有別的案件的有效承租人身分時，身分不失效', async () => {
    const first = await seedMember('tenant@example.com', 'lessee');
    await seedMember('tenant@example.com', 'lessee');
    const result = await loginAs('tenant@example.com');
    await withTx({ kind: 'org', orgId: kit.orgA }, (tx) =>
      tx.query(
        `UPDATE org.case_members SET valid_period = tstzrange(lower(valid_period) - interval '1 day', now() - interval '1 second', '[)')
          WHERE case_id = $1`,
        [first.caseId],
      ),
    );
    expect(await resolveRequestContext(result.token, at(2000), 'r2')).toMatchObject({ kind: 'party' });
  });
});

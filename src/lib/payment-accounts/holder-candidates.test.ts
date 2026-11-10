import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pgliteDriver } from '../pg/drivers';
import { seedCases, testCaseId } from '../pg/test-cases';
import { asRole, createTestDb, type TestDb } from '../pg/test-harness';
import { seedCaseMember, seedOrgMember, seedParty } from '../pg/test-parties';
import { newUlid } from '../pg/ulid';
import { createWithTx, type OrgTx, type WithTx } from '../pg/with-tx';
import { isHolderCandidate, listHolderCandidates } from './holder-candidates';

// MIL-187：收款帳戶持有人的選單。選項是本組織的成員與本組織案件的成員，
// 只回顯示名稱與 party ID。seam 是 listHolderCandidates 與 isHolderCandidate。

const CASE_A = testCaseId('HCASEA');
const CASE_B = testCaseId('HCASEB');

describe('收款帳戶持有人的候選清單', () => {
  let testDb: TestDb;
  let db: PGliteInterface;
  let withTx: WithTx;
  const orgA = newUlid();
  const orgB = newUlid();

  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(() => testDb.close());
  beforeEach(async () => {
    db = await testDb.fresh();
    withTx = createWithTx(pgliteDriver(db));
    await asRole(db, 'app_owner', () =>
      db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner'), ($2, 'B', 'owner')`, [orgA, orgB]),
    );
    await seedCases(withTx, [orgA], [CASE_A]);
    await seedCases(withTx, [orgB], [CASE_B]);
  });

  const inA = <T>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: orgA }, fn);

  it('列出本組織的成員與本組織案件的成員，每人只有顯示名稱與 party ID', async () => {
    const staff = await seedOrgMember(withTx, orgA, '陳經辦');
    const tenant = await seedParty(withTx, orgA, '林承租');
    await seedCaseMember(withTx, orgA, CASE_A, tenant);

    const list = await inA((tx) => listHolderCandidates(tx));

    // 中文名稱的排序依資料庫的定序而不同，這裡只驗內容，順序另有測試
    expect([...list].sort((a, b) => a.partyId.localeCompare(b.partyId))).toEqual(
      [
        { partyId: staff, displayName: '陳經辦' },
        { partyId: tenant, displayName: '林承租' },
      ].sort((a, b) => a.partyId.localeCompare(b.partyId)),
    );
  });

  it('不列出別的組織的人員：別的組織的成員與別的組織案件的成員都不在清單內', async () => {
    const mine = await seedOrgMember(withTx, orgA, '甲組織成員');
    const theirStaff = await seedOrgMember(withTx, orgB, '乙組織成員');
    const theirTenant = await seedParty(withTx, orgB, '乙組織承租人');
    await seedCaseMember(withTx, orgB, CASE_B, theirTenant);

    const list = await inA((tx) => listHolderCandidates(tx));

    expect(list.map((c) => c.partyId)).toEqual([mine]);
    expect(await inA((tx) => isHolderCandidate(tx, theirStaff))).toBe(false);
    expect(await inA((tx) => isHolderCandidate(tx, theirTenant))).toBe(false);
  });

  it('同一個人同時是兩個組織的成員時，兩邊的清單都有，但各自只看到自己的關係', async () => {
    const shared = await seedOrgMember(withTx, orgA, '雙組織成員');
    await withTx({ kind: 'org', orgId: orgB }, async (tx) => {
      const { rows } = await tx.query<{ id: string }>('SELECT id FROM control.users WHERE party_id = $1', [shared]);
      await tx.query('INSERT INTO control.org_memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, $4)', [newUlid(), orgB, rows[0].id, 'viewer']);
    });

    expect((await inA((tx) => listHolderCandidates(tx))).map((c) => c.partyId)).toEqual([shared]);
    expect((await withTx({ kind: 'org', orgId: orgB }, (tx) => listHolderCandidates(tx))).map((c) => c.partyId)).toEqual([shared]);
  });

  it('同時是組織成員與案件成員的人只出現一次', async () => {
    const both = await seedOrgMember(withTx, orgA, '王雙重');
    await seedCaseMember(withTx, orgA, CASE_A, both, { relation: 'lessor' });
    await seedCaseMember(withTx, orgA, CASE_A, both, { relation: 'owner' });

    expect(await inA((tx) => listHolderCandidates(tx))).toEqual([{ partyId: both, displayName: '王雙重' }]);
  });

  it('已經結束的案件成員關係不列入；沒有任何關係的 party 也不列入', async () => {
    const ended = await seedParty(withTx, orgA, '已結束成員');
    await seedCaseMember(withTx, orgA, CASE_A, ended, { ended: true });
    const stranger = await seedParty(withTx, orgA, '路人');

    expect(await inA((tx) => listHolderCandidates(tx))).toEqual([]);
    expect(await inA((tx) => isHolderCandidate(tx, ended))).toBe(false);
    expect(await inA((tx) => isHolderCandidate(tx, stranger))).toBe(false);
  });

  it('回傳內容沒有 email 或其他個資欄位', async () => {
    await seedOrgMember(withTx, orgA, '陳經辦');
    const text = JSON.stringify(await inA((tx) => listHolderCandidates(tx)));
    expect(text).not.toContain('@');
    expect(text).not.toContain('email');
    expect(Object.keys(JSON.parse(text)[0]).sort()).toEqual(['displayName', 'partyId']);
  });

  it('依顯示名稱排序，名稱相同時依 party ID', async () => {
    const [x, y] = [await seedOrgMember(withTx, orgA, '同名'), await seedOrgMember(withTx, orgA, '同名')];
    await seedOrgMember(withTx, orgA, 'A 開頭');

    const list = await inA((tx) => listHolderCandidates(tx));

    expect(list.map((c) => c.displayName)).toEqual(['A 開頭', '同名', '同名']);
    expect(list.slice(1).map((c) => c.partyId)).toEqual([x, y].sort());
  });

  it('isHolderCandidate：格式錯誤、不存在、別的組織的 party 都回 false', async () => {
    const mine = await seedOrgMember(withTx, orgA, '甲');
    expect(await inA((tx) => isHolderCandidate(tx, mine))).toBe(true);
    expect(await inA((tx) => isHolderCandidate(tx, newUlid()))).toBe(false);
    expect(await inA((tx) => isHolderCandidate(tx, 'not-a-ulid'))).toBe(false);
    expect(await inA((tx) => isHolderCandidate(tx, ''))).toBe(false);
  });
});

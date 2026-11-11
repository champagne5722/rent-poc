import type { PGliteInterface } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { STORED_STATUSES, TRANSITIONS, applyTransition, type RequestFacts, type StoredStatus } from '../mandate-requests/status';
import { pgliteDriver } from './drivers';
import { asRole, createTestDb, type TestDb } from './test-harness';
import { newUlid } from './ulid';
import { createWithTx, type OrgTx, type WithTx } from './with-tx';

// MIL-210 前半資料段：接受、未接受與結束（migration 0087）。一律以 app_rw 從外部觀察，看列或備資料時才換成 app_owner。
// 轉移表在 status.ts，SQL 函式的放行與否在這裡逐格比對。併發的案例在 mandate-request-decisions.pg.test.ts（真實 PostgreSQL）。

let testDb: TestDb;
let db: PGliteInterface;
let withTx: WithTx;
const owner = <T>(fn: () => Promise<T>) => asRole(db, 'app_owner', fn);

const practiceOrg = newUlid();
const ownerOrg = newUlid();
const otherPracticeOrg = newUlid();
const thirdOwnerOrg = newUlid();
const practiceParty = newUlid();
const practiceStaffParty = newUlid();
const ownerParty = newUlid();
const ownerStaffParty = newUlid();
const ownerViewerParty = newUlid();
const otherParty = newUlid();
const thirdOwnerParty = newUlid();
const entityId = newUlid();
const otherEntityId = newUlid();

const NOW = new Date(Date.now() - 60 * 60 * 1000);
const hash = (n: string) => createHash('sha256').update(n).digest('hex');
const hours = (n: number, from: Date) => new Date(from.getTime() + n * 3_600_000);
const created = hours(-48, NOW);
const submittedAt = hours(-24, NOW);
const acceptedAt = hours(-12, NOW);

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(() => testDb.close());

beforeEach(async () => {
  db = await testDb.fresh();
  withTx = createWithTx(pgliteDriver(db));
  await owner(async () => {
    await db.query(
      `INSERT INTO control.orgs (id, name, kind) VALUES ($1, '甲業者', 'practice'), ($2, '王先生', 'owner'), ($3, '乙業者', 'practice'), ($4, '李先生', 'owner')`,
      [practiceOrg, ownerOrg, otherPracticeOrg, thirdOwnerOrg],
    );
    const members: Array<[string, string, string, string]> = [
      [practiceOrg, practiceParty, 'admin', 'practice-admin'],
      [practiceOrg, practiceStaffParty, 'staff', 'practice-staff'],
      [ownerOrg, ownerParty, 'admin', 'owner-admin'],
      [ownerOrg, ownerStaffParty, 'staff', 'owner-staff'],
      [ownerOrg, ownerViewerParty, 'viewer', 'owner-viewer'],
      [otherPracticeOrg, otherParty, 'admin', 'other-admin'],
      [thirdOwnerOrg, thirdOwnerParty, 'admin', 'third-owner'],
    ];
    for (const [orgId, partyId, role, label] of members) {
      await db.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, $2, $3)`, [partyId, `${label}@example.com`, label]);
      const userId = newUlid();
      await db.query(`INSERT INTO control.users (id, party_id) VALUES ($1, $2)`, [userId, partyId]);
      await db.query(`INSERT INTO control.org_memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, $4)`, [newUlid(), orgId, userId, role]);
    }
    for (const [id, taxId, name, orgId] of [
      [entityId, '12345678', '甲業者有限公司', practiceOrg],
      [otherEntityId, '87654321', '乙業者有限公司', otherPracticeOrg],
    ]) {
      await db.query(`INSERT INTO registry.practice_entities (id, tax_id, name, entity_type, org_id) VALUES ($1, $2, $3, 'company', $4)`, [id, taxId, name, orgId]);
      await db.query(`INSERT INTO registry.practice_licenses (id, entity_id, kind, state) VALUES ($1, $2, 'management', 'verified')`, [newUlid(), id]);
    }
  });
});

const as = <T>(orgId: string, partyId: string, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId, partyId }, fn);
const asPracticeAdmin = <T>(fn: (tx: OrgTx) => Promise<T>) => as(practiceOrg, practiceParty, fn);
const asPracticeStaff = <T>(fn: (tx: OrgTx) => Promise<T>) => as(practiceOrg, practiceStaffParty, fn);
const asOwnerAdmin = <T>(fn: (tx: OrgTx) => Promise<T>) => as(ownerOrg, ownerParty, fn);

let employmentSeq = 0;
/** 在指定的執業主體下備一位人員與任職（走 app_owner 直接寫）。預設是已驗證、任職中的租賃住宅管理人員。 */
async function seedManager(
  options: { entity?: string; state?: 'pending' | 'verified' | 'lapsed'; practitionerState?: 'pending' | 'verified' | 'lapsed'; kind?: string } = {},
): Promise<string> {
  employmentSeq += 1;
  const party = newUlid();
  const practitioner = newUlid();
  const employment = newUlid();
  const kind = options.kind ?? 'rental_housing_manager';
  const serial = String(100000 + employmentSeq);
  const key = `${kind}:112:內授營:${serial}`;
  await owner(async () => {
    await db.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, $2, $3)`, [party, `manager-${employmentSeq}@example.com`, `管理人員${employmentSeq}`]);
    await db.query(
      `INSERT INTO registry.practitioners (id, party_id, certificate_kind, cert_year, cert_word, cert_serial, certificate_key, issued_on, valid_until, state)
       VALUES ($1, $2, $3, '112', '內授營', $4, $5, '2024-03-01', '2036-03-01', $6)`,
      [practitioner, party, kind, serial, key, options.practitionerState ?? 'verified'],
    );
    await db.query(
      `INSERT INTO registry.practitioner_employments (id, practitioner_id, certificate_key, certificate_kind, entity_id, state, started_on)
       VALUES ($1, $2, $3, $4, $5, $6, '2026-01-01')`,
      [employment, practitioner, key, kind, options.entity ?? entityId, options.state ?? 'verified'],
    );
  });
  return employment;
}

async function newUnit(): Promise<string> {
  return as(ownerOrg, ownerParty, async (tx) => {
    const unitId = newUlid();
    await tx.query('SELECT * FROM registry.create_pending_anchor($1, $2, $3)', [newUlid(), unitId, '某地址']);
    await tx.query('INSERT INTO org.properties (id, org_id, rental_unit_id, name, address) VALUES ($1, $2, $3, $4, $5)', [newUlid(), ownerOrg, unitId, '物件', '某地址']);
    return unitId;
  });
}

/** 直接寫一份指定狀態的申請（走 app_owner），欄位滿足所有檢查約束。送出過的申請含兩個租賃單位。 */
async function seed(status: StoredStatus, options: { submittedAt?: Date; acceptedAt?: Date } = {}): Promise<{ id: string; units: string[] }> {
  const id = newUlid();
  const accepted = ['accepted', 'ended', 'completed'].includes(status);
  const manager = accepted ? await seedManager() : null;
  const units = status === 'pending_owner' ? [] : [await newUnit(), await newUnit()];
  await owner(async () => {
    await db.query(
      `INSERT INTO registry.mandate_requests
         (id, kind, practice_org_id, entity_id, created_by_party_id, code_hash, status, created_at, link_expires_at,
          owner_org_id, claimed_at, submitted_at, withdrawn_at, accepted_at, manager_employment_id, closed_at, closed_by)
       VALUES ($1, 'management', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        id, practiceOrg, entityId, practiceParty, hash(id), status, created, hours(168, created), ownerOrg, created,
        status === 'pending_owner' ? null : (options.submittedAt ?? submittedAt),
        status === 'withdrawn' ? submittedAt : null,
        accepted ? (options.acceptedAt ?? acceptedAt) : null,
        manager,
        status === 'ended' || status === 'declined' ? acceptedAt : null,
        status === 'ended' ? 'owner' : status === 'declined' ? 'practice' : null,
      ],
    );
    for (const u of units) await db.query('INSERT INTO registry.mandate_request_units (request_id, rental_unit_id) VALUES ($1, $2)', [id, u]);
  });
  return { id, units };
}

const accept = (tx: OrgTx, id: string, manager: string, now = NOW) =>
  tx.query<{ outcome: string }>('SELECT * FROM registry.accept_mandate_request($1, $2, $3, $4)', [id, manager, newUlid(), now]);
const decline = (tx: OrgTx, id: string, now = NOW) => tx.query<{ outcome: string }>('SELECT * FROM registry.decline_mandate_request($1, $2, $3)', [id, newUlid(), now]);
const end = (tx: OrgTx, id: string, now = NOW) =>
  tx.query<{ outcome: string; ended_by: string | null }>('SELECT * FROM registry.end_mandate_request($1, $2, $3)', [id, newUlid(), now]);
const withdraw = (tx: OrgTx, id: string) => tx.query<{ outcome: string }>('SELECT * FROM registry.withdraw_mandate_request($1, $2, $3)', [id, newUlid(), NOW]);
const stored = async (id: string) => (await owner(() => db.query<Record<string, unknown>>('SELECT * FROM registry.mandate_requests WHERE id = $1', [id]))).rows[0];
const notesOf = (orgId: string, partyId: string) =>
  as(orgId, partyId, async (tx) => (await tx.query<{ kind: string; title: string; body: string; link_path: string }>('SELECT kind, title, body, link_path FROM org.notifications ORDER BY created_at')).rows);

describe('registry.accept_mandate_request', () => {
  it('業者 admin 接受：狀態、時間與管理人員寫入，同交易通知屋主，脈絡切回業者', async () => {
    const { id } = await seed('pending_practice');
    const manager = await seedManager();
    const result = await asPracticeAdmin(async (tx) => {
      const r = await accept(tx, id, manager);
      const org = (await tx.query<{ v: string }>(`SELECT current_setting('app.org_id', true) AS v`)).rows[0].v;
      return { rows: r.rows, org };
    });
    expect(result.rows).toEqual([{ outcome: 'accepted' }]);
    expect(result.org).toBe(practiceOrg);
    expect(await stored(id)).toMatchObject({ status: 'accepted', manager_employment_id: manager, closed_at: null, closed_by: null });
    expect((await stored(id)).accepted_at).toEqual(NOW);
    expect(await notesOf(ownerOrg, ownerParty)).toEqual([
      { kind: 'request.accepted', title: '申請已接受', body: '業者接受了你送出的委託管理申請，含 2 個租賃單位。', link_path: `/requests/${id}` },
    ]);
    expect(await notesOf(practiceOrg, practiceParty)).toEqual([]);
  });

  it('通知不帶業者與管理人員的名稱、email', async () => {
    const { id } = await seed('pending_practice');
    const manager = await seedManager();
    await asPracticeAdmin((tx) => accept(tx, id, manager));
    const text = JSON.stringify(await notesOf(ownerOrg, ownerParty));
    for (const leak of ['甲業者', '12345678', 'practice-admin@example.com', 'manager-', '管理人員']) expect(text).not.toContain(leak);
  });

  it('staff、沒有成員身分、營運者脈絡被拒（42501），什麼都不寫', async () => {
    const { id } = await seed('pending_practice');
    const manager = await seedManager();
    await expect(asPracticeStaff((tx) => accept(tx, id, manager))).rejects.toMatchObject({ code: '42501' });
    await expect(withTx({ kind: 'org', orgId: practiceOrg }, (tx) => accept(tx, id, manager))).rejects.toMatchObject({ code: '42501' });
    await expect(withTx({ kind: 'control' }, (tx) => accept(tx, id, manager))).rejects.toMatchObject({ code: '42501' });
    expect((await stored(id)).status).toBe('pending_practice');
  });

  it('別家業者與屋主組織：回 not_found，與不存在的申請逐位元相同', async () => {
    const { id } = await seed('pending_practice');
    const manager = await seedManager();
    const theirManager = await seedManager({ entity: otherEntityId });
    const missing = (await as(otherPracticeOrg, otherParty, (tx) => accept(tx, newUlid(), theirManager))).rows;
    expect((await as(otherPracticeOrg, otherParty, (tx) => accept(tx, id, theirManager))).rows).toEqual(missing);
    expect(missing).toEqual([{ outcome: 'not_found' }]);
    expect((await asOwnerAdmin((tx) => accept(tx, id, manager))).rows).toEqual([{ outcome: 'not_found' }]);
    expect((await stored(id)).status).toBe('pending_practice');
  });

  it('管理人員不合格：別家的任職、任職未驗證或已失效、證書待驗證、不是管理人員的證書、不存在的 ID，都被拒', async () => {
    const { id } = await seed('pending_practice');
    const bad = [
      await seedManager({ entity: otherEntityId }),
      await seedManager({ state: 'pending' }),
      await seedManager({ state: 'lapsed' }),
      await seedManager({ practitionerState: 'pending' }),
      await seedManager({ kind: 'real_estate_broker' }),
      newUlid(),
    ];
    for (const manager of bad) {
      expect((await asPracticeAdmin((tx) => accept(tx, id, manager))).rows).toEqual([{ outcome: 'manager_not_eligible' }]);
    }
    expect((await stored(id)).status).toBe('pending_practice');
    expect(await notesOf(ownerOrg, ownerParty)).toEqual([]);
  });

  it('申請對應的業別已不是 verified：回 license_not_verified', async () => {
    const { id } = await seed('pending_practice');
    const manager = await seedManager();
    await owner(() => db.query(`UPDATE registry.practice_licenses SET state = 'lapsed' WHERE entity_id = $1 AND kind = 'management'`, [entityId]));
    expect((await asPracticeAdmin((tx) => accept(tx, id, manager))).rows).toEqual([{ outcome: 'license_not_verified' }]);
  });

  it('不是待業者接受的申請都回 not_pending，已失效的回應與狀態不符相同，什麼都不改', async () => {
    const manager = await seedManager();
    const cases: Array<[string, { id: string }]> = [
      ['pending_owner', await seed('pending_owner')],
      ['withdrawn', await seed('withdrawn')],
      ['declined', await seed('declined')],
      ['accepted', await seed('accepted')],
      ['ended', await seed('ended')],
      ['completed', await seed('completed')],
      ['已失效的待業者接受（送出後 8 天）', await seed('pending_practice', { submittedAt: hours(-24 * 8, NOW) })],
      ['已失效的已接受（接受後 31 天）', await seed('accepted', { acceptedAt: hours(-24 * 31, NOW) })],
    ];
    for (const [name, { id }] of cases) {
      const before = await stored(id);
      expect({ name, rows: (await asPracticeAdmin((tx) => accept(tx, id, manager))).rows }).toEqual({ name, rows: [{ outcome: 'not_pending' }] });
      expect(await stored(id)).toEqual(before);
    }
    expect(await notesOf(ownerOrg, ownerParty)).toEqual([]);
  });

  it('p_now 晚於資料庫時間超過 5 分鐘被拒（22023）', async () => {
    const { id } = await seed('pending_practice');
    const manager = await seedManager();
    await expect(asPracticeAdmin((tx) => accept(tx, id, manager, new Date(Date.now() + 3_600_000)))).rejects.toMatchObject({ code: '22023' });
  });

  it('接受不寫案件成員，呼叫者關係在接受前後對各組織回同樣的值', async () => {
    const { id } = await seed('pending_practice');
    const manager = await seedManager();
    // caller_relation 是內部函式，app_rw 不能直接呼叫，所以用 app_owner 帶組織脈絡呼叫
    const relationOf = (orgId: string) =>
      owner(async () => {
        await db.query(`SELECT set_config('app.org_id', $1, false)`, [orgId]);
        const { rows } = await db.query<{ r: string }>('SELECT registry.caller_relation($1) AS r', [entityId]);
        await db.query(`SELECT set_config('app.org_id', '', false)`);
        return rows[0].r;
      });
    const relations = async () => ({ owner: await relationOf(ownerOrg), other: await relationOf(otherPracticeOrg), own: await relationOf(practiceOrg) });
    const before = await relations();
    await asPracticeAdmin((tx) => accept(tx, id, manager));
    expect(await relations()).toEqual(before);
    expect(before).toEqual({ owner: 'none', other: 'none', own: 'own' });
    expect((await owner(() => db.query('SELECT 1 FROM org.case_members'))).rows).toEqual([]);
  });
});

describe('registry.decline_mandate_request', () => {
  it('業者 admin 不接受：狀態、時間與一方寫入，通知屋主只寫「未接受」', async () => {
    const { id } = await seed('pending_practice');
    expect((await asPracticeAdmin((tx) => decline(tx, id))).rows).toEqual([{ outcome: 'declined' }]);
    const row = await stored(id);
    expect(row).toMatchObject({ status: 'declined', closed_by: 'practice', manager_employment_id: null, accepted_at: null });
    expect(row.closed_at).toEqual(NOW);
    expect(await notesOf(ownerOrg, ownerParty)).toEqual([
      { kind: 'request.declined', title: '申請未接受', body: '你送出的委託管理申請未接受。', link_path: `/requests/${id}` },
    ]);
  });

  it('資料庫沒有任何存原因的欄位', async () => {
    const { rows } = await owner(() =>
      db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'registry' AND table_name = 'mandate_requests'`),
    );
    expect(rows.map((r) => r.column_name).filter((c) => /reason|note|memo|comment|cause/i.test(c))).toEqual([]);
  });

  it('staff 被拒；別家業者與屋主回 not_found；不是待業者接受或已失效回 not_pending', async () => {
    const { id } = await seed('pending_practice');
    await expect(asPracticeStaff((tx) => decline(tx, id))).rejects.toMatchObject({ code: '42501' });
    expect((await as(otherPracticeOrg, otherParty, (tx) => decline(tx, id))).rows).toEqual([{ outcome: 'not_found' }]);
    expect((await asOwnerAdmin((tx) => decline(tx, id))).rows).toEqual([{ outcome: 'not_found' }]);
    const others = [await seed('accepted'), await seed('withdrawn'), await seed('declined'), await seed('ended'), await seed('pending_practice', { submittedAt: hours(-24 * 8, NOW) })];
    for (const other of others) {
      expect((await asPracticeAdmin((tx) => decline(tx, other.id))).rows).toEqual([{ outcome: 'not_pending' }]);
    }
    expect((await stored(id)).status).toBe('pending_practice');
  });
});

describe('registry.end_mandate_request', () => {
  it('業者 admin 結束：closed_by 是 practice，通知屋主「業者已結束申請」', async () => {
    const { id } = await seed('accepted');
    expect((await asPracticeAdmin((tx) => end(tx, id))).rows).toEqual([{ outcome: 'ended', ended_by: 'practice' }]);
    expect(await stored(id)).toMatchObject({ status: 'ended', closed_by: 'practice' });
    expect(await notesOf(ownerOrg, ownerParty)).toEqual([
      { kind: 'request.ended', title: '業者已結束申請', body: '業者結束了一份委託管理申請。', link_path: `/requests/${id}` },
    ]);
    expect(await notesOf(practiceOrg, practiceParty)).toEqual([]);
  });

  it('屋主 admin 與 staff 都能結束：closed_by 是 owner，通知業者「屋主已結束申請」', async () => {
    for (const partyId of [ownerParty, ownerStaffParty]) {
      const { id } = await seed('accepted');
      expect((await as(ownerOrg, partyId, (tx) => end(tx, id))).rows).toEqual([{ outcome: 'ended', ended_by: 'owner' }]);
      expect(await stored(id)).toMatchObject({ status: 'ended', closed_by: 'owner' });
    }
    expect((await notesOf(practiceOrg, practiceParty)).map((n) => [n.kind, n.title, n.body])).toEqual([
      ['request.ended', '屋主已結束申請', '屋主結束了一份委託管理申請。'],
      ['request.ended', '屋主已結束申請', '屋主結束了一份委託管理申請。'],
    ]);
    expect(await notesOf(ownerOrg, ownerParty)).toEqual([]);
  });

  it('業者 staff、屋主 viewer、沒有成員身分被拒（42501）', async () => {
    const { id } = await seed('accepted');
    await expect(asPracticeStaff((tx) => end(tx, id))).rejects.toMatchObject({ code: '42501' });
    await expect(as(ownerOrg, ownerViewerParty, (tx) => end(tx, id))).rejects.toMatchObject({ code: '42501' });
    await expect(withTx({ kind: 'org', orgId: ownerOrg }, (tx) => end(tx, id))).rejects.toMatchObject({ code: '42501' });
    expect((await stored(id)).status).toBe('accepted');
  });

  it('第三個屋主與別家業者不能結束：回 not_found，與不存在的申請相同', async () => {
    const { id } = await seed('accepted');
    const missing = (await as(thirdOwnerOrg, thirdOwnerParty, (tx) => end(tx, newUlid()))).rows;
    expect((await as(thirdOwnerOrg, thirdOwnerParty, (tx) => end(tx, id))).rows).toEqual(missing);
    expect((await as(otherPracticeOrg, otherParty, (tx) => end(tx, id))).rows).toEqual(missing);
    expect(missing).toEqual([{ outcome: 'not_found', ended_by: null }]);
    expect((await stored(id)).status).toBe('accepted');
  });

  it('不是已接受的申請都回 not_pending，已失效的相同（接受後 31 天）', async () => {
    const cases = [
      await seed('pending_practice'), await seed('declined'), await seed('withdrawn'), await seed('ended'), await seed('completed'),
      await seed('accepted', { acceptedAt: hours(-24 * 31, NOW) }),
    ];
    for (const { id } of cases) {
      const before = await stored(id);
      expect((await asPracticeAdmin((tx) => end(tx, id))).rows).toEqual([{ outcome: 'not_pending', ended_by: null }]);
      expect(await stored(id)).toEqual(before);
    }
    expect(await notesOf(ownerOrg, ownerParty)).toEqual([]);
  });

  it('結束之後，租賃單位不再被這份申請佔用', async () => {
    const { id, units } = await seed('accepted');
    const occupied = async () =>
      (await owner(() => db.query('SELECT * FROM registry.occupied_rental_units($1, $2::text[], $3, NULL)', [ownerOrg, units, NOW]))).rows.length;
    expect(await occupied()).toBe(2);
    await asPracticeAdmin((tx) => end(tx, id));
    expect(await occupied()).toBe(0);
  });
});

describe('同一份申請的先後順序：後到的請求看到新狀態', () => {
  it('接受之後屋主收回回 not_pending；收回之後業者接受回 not_pending', async () => {
    const a = await seed('pending_practice');
    const b = await seed('pending_practice');
    const manager = await seedManager();
    expect((await asPracticeAdmin((tx) => accept(tx, a.id, manager))).rows).toEqual([{ outcome: 'accepted' }]);
    expect((await asOwnerAdmin((tx) => withdraw(tx, a.id))).rows).toEqual([{ outcome: 'not_pending' }]);
    expect((await asOwnerAdmin((tx) => withdraw(tx, b.id))).rows).toEqual([{ outcome: 'withdrawn' }]);
    expect((await asPracticeAdmin((tx) => accept(tx, b.id, manager))).rows).toEqual([{ outcome: 'not_pending' }]);
  });

  it('已接受之後再接受、再不接受都回 not_pending；已結束之後再結束回 not_pending', async () => {
    const { id } = await seed('pending_practice');
    const manager = await seedManager();
    await asPracticeAdmin((tx) => accept(tx, id, manager));
    expect((await asPracticeAdmin((tx) => accept(tx, id, manager))).rows).toEqual([{ outcome: 'not_pending' }]);
    expect((await asPracticeAdmin((tx) => decline(tx, id))).rows).toEqual([{ outcome: 'not_pending' }]);
    await asOwnerAdmin((tx) => end(tx, id));
    expect((await asPracticeAdmin((tx) => end(tx, id))).rows).toEqual([{ outcome: 'not_pending', ended_by: null }]);
  });
});

describe('檢查約束', () => {
  const insert = (status: string, extraColumn = '', extraValue = '') =>
    owner(() =>
      db.query(
        `INSERT INTO registry.mandate_requests (id, kind, practice_org_id, entity_id, created_by_party_id, code_hash, status, created_at, link_expires_at, owner_org_id, claimed_at, submitted_at${extraColumn})
         VALUES ($1, 'management', $2, $3, $4, $5, $6, $7, $8, $9, $7, $7${extraValue})`,
        [newUlid(), practiceOrg, entityId, practiceParty, hash(newUlid()), status, created, hours(168, created), ownerOrg],
      ),
    );

  it('已接受必須有接受時間與管理人員', async () => {
    await expect(insert('accepted')).rejects.toThrow(/mandate_requests_accepted_has_manager/);
    await expect(insert('accepted', ', accepted_at', `, '2026-11-10T00:00:00Z'`)).rejects.toThrow(/mandate_requests_accepted_has_manager/);
  });

  it('未接受與已結束必須有結束時間與一方，未接受只能是業者，沒結束的申請不能有結束的一方', async () => {
    await expect(insert('declined')).rejects.toThrow(/mandate_requests_closed_has_actor/);
    await expect(insert('declined', ', closed_at', `, '2026-11-10T00:00:00Z'`)).rejects.toThrow(/mandate_requests_closed_has_actor/);
    const manager = await seedManager();
    await expect(insert('ended', ', accepted_at, manager_employment_id', `, '2026-11-10T00:00:00Z', '${manager}'`)).rejects.toThrow(/mandate_requests_closed_has_actor/);
    await expect(insert('declined', ', closed_at, closed_by', `, '2026-11-10T00:00:00Z', 'owner'`)).rejects.toThrow(/mandate_requests_declined_by_practice/);
    await expect(insert('pending_practice', ', closed_by', `, 'practice'`)).rejects.toThrow(/mandate_requests_closed_by_only_when_closed/);
  });
});

describe('轉移表與 SQL 逐格比對', () => {
  // 每個事件 x 每個儲存狀態：SQL 函式放不放行，必須與 status.ts 的 applyTransition 相同。
  // 誰能呼叫由 TRANSITIONS 的 by 對應：接受、未接受、結束用業者 admin，收回用屋主 admin。
  const events = ['accept', 'decline', 'end', 'withdraw'] as const;
  const OK = { accept: 'accepted', decline: 'declined', end: 'ended', withdraw: 'withdrawn' } as const;
  for (const event of events) {
    for (const status of STORED_STATUSES) {
      it(`${event} 從 ${status}`, async () => {
        const { id } = await seed(status);
        const manager = await seedManager();
        const facts: RequestFacts = {
          status,
          linkExpiresAt: hours(168, created),
          submittedAt: status === 'pending_owner' ? null : submittedAt,
          acceptedAt: ['accepted', 'ended', 'completed'].includes(status) ? acceptedAt : null,
          contractSentAt: null,
        };
        const expected = applyTransition(facts, event, NOW);
        let outcome: string;
        if (event === 'accept') outcome = (await asPracticeAdmin((tx) => accept(tx, id, manager))).rows[0].outcome;
        else if (event === 'decline') outcome = (await asPracticeAdmin((tx) => decline(tx, id))).rows[0].outcome;
        else if (event === 'end') outcome = (await asPracticeAdmin((tx) => end(tx, id))).rows[0].outcome;
        else outcome = (await asOwnerAdmin((tx) => withdraw(tx, id))).rows[0].outcome;
        expect(outcome === OK[event]).toBe(expected.ok);
        expect((await stored(id)).status).toBe(expected.ok ? TRANSITIONS[event].to : status);
      });
    }
  }
});

describe('讀取：兩邊看到的欄位', () => {
  const practiceView = async (id: string) =>
    (await asPracticeAdmin((tx) => tx.query<Record<string, unknown>>('SELECT * FROM registry.mandate_requests_for_practice($1, $2)', [id, NOW]))).rows[0];
  const ownerView = async (id: string) =>
    (await asOwnerAdmin((tx) => tx.query<Record<string, unknown>>('SELECT * FROM registry.mandate_requests_for_owner($1, $2)', [id, NOW]))).rows[0];

  it('已接受：業者看得到自己指派的管理人員，屋主的回應沒有任職 ID，也沒有這個欄位', async () => {
    const { id } = await seed('pending_practice');
    const manager = await seedManager();
    await asPracticeAdmin((tx) => accept(tx, id, manager));
    expect(await practiceView(id)).toMatchObject({ status: 'accepted', manager_employment_id: manager, closed_at: null, closed_by: null });
    const seen = await ownerView(id);
    expect(seen).toMatchObject({ status: 'accepted', closed_at: null, closed_by: null });
    expect(seen.accepted_at).toEqual(NOW);
    expect(Object.keys(seen)).not.toContain('manager_employment_id');
    expect(JSON.stringify(seen)).not.toContain(manager);
  });

  it('未接受：屋主的回應逐欄位沒有原因、沒有管理人員、沒有業者端的欄位', async () => {
    const { id } = await seed('pending_practice');
    await asPracticeAdmin((tx) => decline(tx, id));
    const seen = await ownerView(id);
    expect(seen).toMatchObject({ status: 'declined', closed_by: 'practice', accepted_at: null, draft: null });
    expect(Object.keys(seen).sort()).toEqual(
      [
        'request_id', 'kind', 'status', 'created_at', 'link_expires_at', 'claimed_at', 'submitted_at', 'withdrawn_at', 'accepted_at',
        'contract_sent_at', 'practice_name', 'tax_id', 'verified_kinds', 'draft', 'has_transcript', 'transcript_file_name',
        'draft_confirmed_at', 'confirmed_unit_id', 'unit_ids', 'closed_at', 'closed_by',
      ].sort(),
    );
  });

  it('已結束：雙方都看到結束的一方', async () => {
    const { id } = await seed('accepted');
    await asOwnerAdmin((tx) => end(tx, id));
    expect(await practiceView(id)).toMatchObject({ status: 'ended', closed_by: 'owner' });
    expect(await ownerView(id)).toMatchObject({ status: 'ended', closed_by: 'owner' });
  });
});

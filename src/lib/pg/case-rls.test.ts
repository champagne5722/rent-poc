import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CASE_EVENT_TYPES,
  CASE_MEMBER_RELATIONS,
  LEASE_CASE_STATES,
  MANAGEMENT_CASE_STATES,
  type CaseMemberRelation,
} from '../cases';
import { pgliteDriver } from './drivers';
import { CASE_SCOPED_READS } from './rls-cases';
import { asRole, createTestDb, type TestDb } from './test-harness';
import { newUlid } from './ulid';
import { createWithTx, type WithTx } from './with-tx';

// 案件範圍表的成員讀取矩陣與 schema 一致性（ADR-0016 決議 15，MIL-115）。
// 連線是 PGlite 的 app_rw，RLS 生效。接縫是資料庫本身：以不同身分查表，看得到幾列。

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(() => testDb.close());

describe('案件表的 schema 與純函式模組的常數一致', () => {
  let db: PGliteInterface;
  let withTx: WithTx;
  const org = newUlid();

  beforeEach(async () => {
    db = await testDb.fresh();
    withTx = createWithTx(pgliteDriver(db));
    await asRole(db, 'app_owner', () => db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner')`, [org]));
  });

  async function accepts(sql: string, params: unknown[]): Promise<boolean> {
    try {
      await withTx({ kind: 'org', orgId: org }, (tx) => tx.query(sql, params));
      return true;
    } catch (error) {
      if (/check constraint|violates/.test(String(error))) return false;
      throw error;
    }
  }

  const insertCase = (kind: 'lease' | 'management', state: string) =>
    accepts(`INSERT INTO org.cases (id, org_id, kind, state, business_type) VALUES ($1, $2, $3, $4, $5)`, [
      newUlid(),
      org,
      kind,
      state,
      kind === 'lease' ? 'self_managed' : null,
    ]);

  it.each(LEASE_CASE_STATES)('租賃案件接受狀態 %s', async (state) => {
    expect(await insertCase('lease', state)).toBe(true);
  });

  it.each(MANAGEMENT_CASE_STATES)('委託管理案件接受狀態 %s', async (state) => {
    expect(await insertCase('management', state)).toBe(true);
  });

  it('租賃案件拒絕委託管理案件的狀態，反之亦然', async () => {
    expect(await insertCase('lease', 'terminated')).toBe(false);
    expect(await insertCase('lease', 'expired')).toBe(false);
    expect(await insertCase('management', 'move_out')).toBe(false);
    expect(await insertCase('management', 'closed')).toBe(false);
    expect(await insertCase('lease', 'nonsense')).toBe(false);
  });

  it('租賃案件必須有業務類型，委託管理案件不得有', async () => {
    expect(
      await accepts(`INSERT INTO org.cases (id, org_id, kind, state) VALUES ($1, $2, 'lease', 'draft')`, [newUlid(), org]),
    ).toBe(false);
    expect(
      await accepts(
        `INSERT INTO org.cases (id, org_id, kind, state, business_type) VALUES ($1, $2, 'management', 'draft', 'managed')`,
        [newUlid(), org],
      ),
    ).toBe(false);
  });

  it('案件事件的 type 清單與 CASE_EVENT_TYPES 逐一一致', async () => {
    const caseId = newUlid();
    await withTx({ kind: 'org', orgId: org }, (tx) =>
      tx.query(`INSERT INTO org.cases (id, org_id, kind, state, business_type) VALUES ($1, $2, 'lease', 'draft', 'self_managed')`, [
        caseId,
        org,
      ]),
    );
    for (const type of CASE_EVENT_TYPES) {
      const ok = await accepts(`INSERT INTO org.case_events (id, org_id, case_id, type, occurred_at) VALUES ($1, $2, $3, $4, now())`, [
        newUlid(),
        org,
        caseId,
        type,
      ]);
      expect({ type, ok }).toEqual({ type, ok: true });
    }
    const bad = await accepts(`INSERT INTO org.case_events (id, org_id, case_id, type, occurred_at) VALUES ($1, $2, $3, 'not_an_event', now())`, [
      newUlid(),
      org,
      caseId,
    ]);
    expect(bad).toBe(false);
  });

  it('案件成員的 relation 清單與 CASE_MEMBER_RELATIONS 逐一一致', async () => {
    const caseId = newUlid();
    await withTx({ kind: 'org', orgId: org }, async (tx) => {
      await tx.query(`INSERT INTO org.cases (id, org_id, kind, state, business_type) VALUES ($1, $2, 'lease', 'draft', 'self_managed')`, [caseId, org]);
      await tx.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'rel@example.com', 'x')`, [newUlid()]);
    });
    const { rows } = await withTx({ kind: 'control' }, (tx) => tx.query<{ id: string }>(`SELECT id FROM control.parties`));
    const partyId = rows[0].id;
    for (const relation of CASE_MEMBER_RELATIONS) {
      const ok = await accepts(`INSERT INTO org.case_members (id, org_id, case_id, party_id, relation) VALUES ($1, $2, $3, $4, $5)`, [
        newUlid(),
        org,
        caseId,
        partyId,
        relation,
      ]);
      expect({ relation, ok }).toEqual({ relation, ok: true });
    }
    expect(
      await accepts(`INSERT INTO org.case_members (id, org_id, case_id, party_id, relation) VALUES ($1, $2, $3, $4, 'manager')`, [
        newUlid(),
        org,
        caseId,
        partyId,
      ]),
    ).toBe(false);
  });

  it('同一人同一關係同時間只能有一列有效，關閉後可以再加入', async () => {
    const caseId = newUlid();
    const partyId = newUlid();
    await withTx({ kind: 'org', orgId: org }, async (tx) => {
      await tx.query(`INSERT INTO org.cases (id, org_id, kind, state, business_type) VALUES ($1, $2, 'lease', 'draft', 'self_managed')`, [caseId, org]);
      await tx.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'dup@example.com', 'x')`, [partyId]);
      await tx.query(`INSERT INTO org.case_members (id, org_id, case_id, party_id, relation) VALUES ($1, $2, $3, $4, 'lessee')`, [newUlid(), org, caseId, partyId]);
    });
    const again = () =>
      accepts(`INSERT INTO org.case_members (id, org_id, case_id, party_id, relation) VALUES ($1, $2, $3, $4, 'lessee')`, [newUlid(), org, caseId, partyId]);
    expect(await again()).toBe(false);
    await withTx({ kind: 'org', orgId: org }, (tx) =>
      tx.query(`UPDATE org.case_members SET valid_period = tstzrange(lower(valid_period), now(), '[)') WHERE case_id = $1`, [caseId]),
    );
    expect(await again()).toBe(true);
  });

  it('每張有 case_id 欄位的 org 表都登記在 CASE_SCOPED_READS', async () => {
    const { rows } = await db.query<{ name: string }>(
      `SELECT table_schema || '.' || table_name AS name FROM information_schema.columns
        WHERE table_schema = 'org' AND column_name = 'case_id' ORDER BY 1`,
    );
    const missing = rows.map((r) => r.name).filter((name) => !(name in CASE_SCOPED_READS));
    expect(missing, '這些表有 case_id 但沒有登記成員可讀的關係，請到 src/lib/pg/rls-cases.ts 的 CASE_SCOPED_READS 補').toEqual([]);
  });

  it('CASE_SCOPED_READS 只列出存在的表', async () => {
    const { rows } = await db.query<{ name: string }>(
      `SELECT n.nspname || '.' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'org' AND c.relkind IN ('r', 'p')`,
    );
    const existing = new Set(rows.map((r) => r.name));
    expect(Object.keys(CASE_SCOPED_READS).filter((t) => !existing.has(t))).toEqual([]);
  });

  it('案件事件寫入後不得修改，也不得刪除', async () => {
    const caseId = newUlid();
    const eventId = newUlid();
    await withTx({ kind: 'org', orgId: org }, async (tx) => {
      await tx.query(`INSERT INTO org.cases (id, org_id, kind, state, business_type) VALUES ($1, $2, 'lease', 'draft', 'self_managed')`, [caseId, org]);
      await tx.query(`INSERT INTO org.case_events (id, org_id, case_id, type, occurred_at) VALUES ($1, $2, $3, 'created', now())`, [eventId, org, caseId]);
    });
    await expect(
      withTx({ kind: 'org', orgId: org }, (tx) => tx.query(`UPDATE org.case_events SET payload = '{"x":1}' WHERE id = $1`, [eventId])),
    ).rejects.toThrow(/案件事件寫入後不得修改或刪除/);
    await expect(
      withTx({ kind: 'org', orgId: org }, (tx) => tx.query(`DELETE FROM org.case_events WHERE id = $1`, [eventId])),
    ).rejects.toThrow(/案件事件寫入後不得修改或刪除/);
  });
});

describe('成員讀取矩陣：每種關係讀得到哪些表', () => {
  let db: PGliteInterface;
  let withTx: WithTx;
  const host = newUlid();
  const other = newUlid();
  const caseId = newUlid();
  const otherCaseId = newUlid();
  const partyOf = Object.fromEntries(CASE_MEMBER_RELATIONS.map((r) => [r, newUlid()])) as Record<CaseMemberRelation, string>;
  const outsider = newUlid();
  const expired = newUlid();

  beforeEach(async () => {
    db = await testDb.fresh();
    withTx = createWithTx(pgliteDriver(db));
    await asRole(db, 'app_owner', () =>
      db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, '主辦', 'practice'), ($2, '其他', 'owner')`, [host, other]),
    );
    await withTx({ kind: 'org', orgId: host }, async (tx) => {
      for (const [i, id] of [...Object.values(partyOf), outsider, expired].entries()) {
        await tx.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, $2, $3)`, [id, `p${i}@example.com`, `p${i}`]);
      }
      for (const id of [caseId, otherCaseId]) {
        await tx.query(
          `INSERT INTO org.cases (id, org_id, kind, state, business_type, title) VALUES ($1, $2, 'lease', 'active', 'master_lease', '測試案件')`,
          [id, host],
        );
      }
      const contractId = newUlid();
      await tx.query(`INSERT INTO org.contracts (id, org_id, case_id) VALUES ($1, $2, $3)`, [contractId, host, caseId]);
      await tx.query(`INSERT INTO org.contracts (id, org_id, case_id) VALUES ($1, $2, $3)`, [newUlid(), host, otherCaseId]);
      const taskId = newUlid();
      await tx.query(
        `INSERT INTO org.sign_tasks (id, org_id, provider, provider_task_ref, subject_type, subject_id) VALUES ($1, $2, 'mock', 'ref', 'contract', $3)`,
        [taskId, host, contractId],
      );
      await tx.query(
        `INSERT INTO org.signers (id, org_id, sign_task_id, position, role, name, email) VALUES ($1, $2, $3, 0, 'party_b', 'x', 'x@example.com')`,
        [newUlid(), host, taskId],
      );
      await tx.query(`INSERT INTO org.case_events (id, org_id, case_id, type, occurred_at) VALUES ($1, $2, $3, 'created', now())`, [newUlid(), host, caseId]);
      await tx.query(`INSERT INTO org.case_events (id, org_id, case_id, type, occurred_at) VALUES ($1, $2, $3, 'created', now())`, [newUlid(), host, otherCaseId]);
      await tx.query(
        `INSERT INTO org.contract_events (id, org_id, contract_id, type, actor) VALUES ($1, $2, $3, 'created', 'landlord')`,
        [newUlid(), host, contractId],
      );
      for (const relation of CASE_MEMBER_RELATIONS) {
        await tx.query(`INSERT INTO org.case_members (id, org_id, case_id, party_id, relation) VALUES ($1, $2, $3, $4, $5)`, [
          newUlid(),
          host,
          caseId,
          partyOf[relation],
          relation,
        ]);
      }
      // 已過期的出租人：valid_period 在過去就結束
      await tx.query(
        `INSERT INTO org.case_members (id, org_id, case_id, party_id, relation, valid_period)
         VALUES ($1, $2, $3, $4, 'lessor', tstzrange(now() - interval '2 days', now() - interval '1 day', '[)'))`,
        [newUlid(), host, caseId, expired],
      );
    });
  });

  /** 以指定 party 開 party 脈絡，數這張表看得到幾列（只算這個案件的列）。 */
  async function visibleTo(partyId: string, table: string): Promise<number> {
    const column = table === 'org.cases' ? 'id' : 'case_id';
    const sql =
      table === 'org.sign_tasks' || table === 'org.signers' || table === 'org.contract_events'
        ? `SELECT count(*)::int AS n FROM ${table}`
        : `SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`;
    const params = sql.includes('$1') ? [caseId] : [];
    const { rows } = await withTx({ kind: 'party', partyId }, (tx) => tx.query<{ n: number }>(sql, params));
    return rows[0].n;
  }

  const TABLES = Object.keys(CASE_SCOPED_READS).filter((t) => t !== 'org.contract_practitioner_assignments' && t !== 'org.signature_records' && t !== 'org.sign_task_files');

  describe.each(CASE_MEMBER_RELATIONS)('%s', (relation) => {
    it.each(TABLES)('讀 %s 的結果符合 CASE_SCOPED_READS', async (table) => {
      const allowed = (CASE_SCOPED_READS[table].readableBy as readonly string[]).includes(relation);
      const n = await visibleTo(partyOf[relation], table);
      if (allowed) expect(n).toBeGreaterThan(0);
      else if (table === 'org.case_members') expect(n).toBe(1); // 只讀自己的列（self_read）
      else expect(n).toBe(0);
    });
  });

  it('peer_read 的關係看得到整個案件的成員，其他關係只看到自己', async () => {
    expect(await visibleTo(partyOf.lessor, 'org.case_members')).toBe(CASE_MEMBER_RELATIONS.length + 1); // 含過期的那一列
    expect(await visibleTo(partyOf.lessee, 'org.case_members')).toBe(1);
    expect(await visibleTo(partyOf.owner, 'org.case_members')).toBe(1);
  });

  it('不是成員的人什麼都讀不到', async () => {
    for (const table of TABLES) expect({ table, n: await visibleTo(outsider, table) }).toEqual({ table, n: 0 });
  });

  it('成員資格過期後，案件相關的表讀不到；自己的成員列仍讀得到（self_read 不看有效期）', async () => {
    for (const table of TABLES.filter((t) => t !== 'org.case_members')) {
      expect({ table, n: await visibleTo(expired, table) }).toEqual({ table, n: 0 });
    }
    expect(await visibleTo(expired, 'org.case_members')).toBe(1);
  });

  it('只讀得到自己是成員的那個案件，讀不到別的案件（P0-09 AC1）', async () => {
    const { rows } = await withTx({ kind: 'party', partyId: partyOf.lessee }, (tx) => tx.query<{ id: string }>(`SELECT id FROM org.cases`));
    expect(rows.map((r) => r.id)).toEqual([caseId]);
    const events = await withTx({ kind: 'party', partyId: partyOf.lessor }, (tx) => tx.query(`SELECT 1 FROM org.case_events WHERE case_id = $1`, [otherCaseId]));
    expect(events.rows).toEqual([]);
  });

  it('屋主以自己組織的身分（org 脈絡加 party）讀得到別的組織的案件，也只讀得到成員的那一個', async () => {
    const { rows } = await withTx({ kind: 'org', orgId: other, partyId: partyOf.lessor }, (tx) =>
      tx.query<{ id: string }>(`SELECT id FROM org.cases`),
    );
    expect(rows.map((r) => r.id)).toEqual([caseId]);
  });

  it('成員政策只開讀取：成員不能改別的組織的案件，也不能新增成員', async () => {
    await expect(
      withTx({ kind: 'party', partyId: partyOf.lessor }, (tx) =>
        tx.query(`UPDATE org.cases SET state = 'closed' WHERE id = $1 RETURNING id`, [caseId]),
      ).then((r) => r.rows),
    ).resolves.toEqual([]);
    await expect(
      withTx({ kind: 'party', partyId: partyOf.lessor }, (tx) =>
        tx.query(`INSERT INTO org.case_members (id, org_id, case_id, party_id, relation) VALUES ($1, $2, $3, $4, 'lessee')`, [newUlid(), host, caseId, outsider]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('其他組織的主辦成員（沒有 party）讀不到這個案件', async () => {
    const { rows } = await withTx({ kind: 'org', orgId: other }, (tx) => tx.query(`SELECT 1 FROM org.cases`));
    expect(rows).toEqual([]);
  });
});

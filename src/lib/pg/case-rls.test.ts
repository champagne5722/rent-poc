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
      const signerId = newUlid();
      await tx.query(
        `INSERT INTO org.signers (id, org_id, sign_task_id, position, role, name, email) VALUES ($1, $2, $3, 0, 'party_b', 'x', 'x@example.com')`,
        [signerId, host, taskId],
      );
      // 合約子表（沒有 case_id）：簽署中失效紀錄與委託標的清單（MIL-75、MIL-74）
      await tx.query(
        `INSERT INTO org.signing_lapses (id, org_id, contract_id, signer_id, rule_id, state, event_at)
         VALUES ($1, $2, $3, $4, 'rls.slot', 'void_pending', now())`,
        [newUlid(), host, contractId, signerId],
      );
      await tx.query(
        `INSERT INTO org.contract_mandate_items (id, org_id, contract_id, position, property_id, property_name, property_address)
         VALUES ($1, $2, $3, 0, 'rls-property', '測試物件', '測試地址')`,
        [newUlid(), host, contractId],
      );
      for (const kind of ['signed_pdf', 'audit_trail']) {
        await tx.query(
          `INSERT INTO org.sign_task_files (id, org_id, sign_task_id, kind, status, file_name, object_key, sha256, byte_size, content_type)
           VALUES ($1, $2, $3, $4, 'saved', $5, $6, $7, 10, 'application/pdf')`,
          [newUlid(), host, taskId, kind, `${kind}.pdf`, `org/${host}/sign-tasks/${taskId}/${kind}.pdf`, 'a'.repeat(64)],
        );
      }
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
      table === 'org.sign_tasks' || table === 'org.signers' || table === 'org.contract_events' || table === 'org.sign_task_files'
        ? `SELECT count(*)::int AS n FROM ${table}`
        : `SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`;
    const params = sql.includes('$1') ? [caseId] : [];
    const { rows } = await withTx({ kind: 'party', partyId }, (tx) => tx.query<{ n: number }>(sql, params));
    return rows[0].n;
  }

  // org.sign_task_files 在這個矩陣內（MIL-121 補政策）。其餘三張表另有專屬案例，不在通用矩陣
  const TABLES = Object.keys(CASE_SCOPED_READS).filter((t) => t !== 'org.contract_practitioner_assignments' && t !== 'org.signature_records' && t !== 'org.signing_lapses' && t !== 'org.contract_mandate_items');

  describe.each(CASE_MEMBER_RELATIONS)('%s', (relation) => {
    it.each(TABLES)('讀 %s 的結果符合 CASE_SCOPED_READS', async (table) => {
      const allowed = (CASE_SCOPED_READS[table].readableBy as readonly string[]).includes(relation);
      const n = await visibleTo(partyOf[relation], table);
      if (allowed) expect(n).toBeGreaterThan(0);
      else if (table === 'org.case_members') expect(n).toBe(1); // 只讀自己的列（self_read）
      else expect(n).toBe(0);
    });
  });

  it('已簽合約檔案：可讀的關係只看到 signed_pdf，看不到 Audit Trail File（MIL-121）', async () => {
    for (const relation of ['lessor', 'lessee', 'co_lessee', 'practitioner', 'broker', 'mandator', 'mandatary'] as const) {
      const { rows } = await withTx({ kind: 'party', partyId: partyOf[relation] }, (tx) =>
        tx.query<{ kind: string }>('SELECT kind FROM org.sign_task_files'),
      );
      expect({ relation, kinds: rows.map((r) => r.kind) }).toEqual({ relation, kinds: ['signed_pdf'] });
    }
    // 包租案件的所有權人讀不到合約，也讀不到合約的簽署檔案（P0-09 AC5）
    const owner = await withTx({ kind: 'party', partyId: partyOf.owner }, (tx) => tx.query('SELECT 1 FROM org.sign_task_files'));
    expect(owner.rows).toEqual([]);
  });

  it('已簽合約檔案：成員資格過期或已關閉後讀不到', async () => {
    await withTx({ kind: 'org', orgId: host }, (tx) =>
      tx.query(
        `UPDATE org.case_members SET valid_period = tstzrange(now() - interval '2 days', now() - interval '1 day', '[)') WHERE party_id = $1`,
        [partyOf.lessee],
      ),
    );
    const { rows } = await withTx({ kind: 'party', partyId: partyOf.lessee }, (tx) => tx.query('SELECT 1 FROM org.sign_task_files'));
    expect(rows).toEqual([]);
  });

  it('已簽合約檔案：別的案件的成員讀不到這個案件的檔案', async () => {
    const stranger = newUlid();
    await withTx({ kind: 'org', orgId: host }, async (tx) => {
      await tx.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'stranger@example.com', 's')`, [stranger]);
      await tx.query(`INSERT INTO org.case_members (id, org_id, case_id, party_id, relation) VALUES ($1, $2, $3, $4, 'lessee')`, [
        newUlid(),
        host,
        otherCaseId,
        stranger,
      ]);
    });
    const { rows } = await withTx({ kind: 'party', partyId: stranger }, (tx) => tx.query('SELECT 1 FROM org.sign_task_files'));
    expect(rows).toEqual([]);
  });

  it('peer_read 的關係看得到整個案件的成員，其他關係只看到自己', async () => {
    expect(await visibleTo(partyOf.lessor, 'org.case_members')).toBe(CASE_MEMBER_RELATIONS.length + 1); // 含過期的那一列
    expect(await visibleTo(partyOf.lessee, 'org.case_members')).toBe(1);
    expect(await visibleTo(partyOf.owner, 'org.case_members')).toBe(1);
  });

  // 合約子表沒有 case_id，案件成員一律讀不到，與其他合約子表相同。表裡確實有列，所以是政策擋下而不是沒資料
  it.each(['org.signing_lapses', 'org.contract_mandate_items'])('案件成員與非成員都讀不到 %s', async (table) => {
    const host_n = await withTx({ kind: 'org', orgId: host }, async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
    expect(host_n).toBeGreaterThan(0);
    for (const partyId of [...Object.values(partyOf), outsider, expired]) {
      const { rows } = await withTx({ kind: 'party', partyId }, (tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`));
      expect({ table, partyId, n: rows[0].n }).toEqual({ table, partyId, n: 0 });
    }
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

describe('org.party_has_tenant_membership：登入時判斷承租人身分（MIL-121）', () => {
  let db: PGliteInterface;
  let withTx: WithTx;
  const host = newUlid();
  const caseId = newUlid();
  const pid = (n: number) => `0000000000000000000000010${n}`;

  beforeEach(async () => {
    db = await testDb.fresh();
    withTx = createWithTx(pgliteDriver(db));
    await asRole(db, 'app_owner', () => db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, '主辦', 'owner')`, [host]));
    await withTx({ kind: 'org', orgId: host }, async (tx) => {
      for (let i = 0; i < 6; i++) await tx.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, $2, 'p')`, [pid(i), `m${i}@example.com`]);
      await tx.query(`INSERT INTO org.cases (id, org_id, kind, state, business_type) VALUES ($1, $2, 'lease', 'active', 'self_managed')`, [caseId, host]);
      const add = (party: string, relation: string, period = `tstzrange(now() - interval '1 day', NULL, '[)')`) =>
        tx.query(`INSERT INTO org.case_members (id, org_id, case_id, party_id, relation, valid_period) VALUES ($1, $2, $3, $4, $5, ${period})`, [
          newUlid(),
          host,
          caseId,
          party,
          relation,
        ]);
      await add(pid(0), 'lessee');
      await add(pid(1), 'co_lessee');
      await add(pid(2), 'lessor');
      await add(pid(3), 'lessee', `tstzrange(now() - interval '2 days', now() - interval '1 day', '[)')`);
    });
  });

  const check = (partyId: string) =>
    withTx({ kind: 'control' }, async (tx) => (await tx.query<{ ok: boolean }>('SELECT org.party_has_tenant_membership($1) AS ok', [partyId])).rows[0].ok);

  it('承租人與共同承租人的有效成員資格回 true', async () => {
    expect(await check(pid(0))).toBe(true);
    expect(await check(pid(1))).toBe(true);
  });

  it('出租人、已關閉的承租人、不是成員的人、空字串都回 false', async () => {
    expect(await check(pid(2))).toBe(false);
    expect(await check(pid(3))).toBe(false);
    expect(await check(pid(4))).toBe(false);
    expect(await check('')).toBe(false);
  });

  it('呼叫前後交易的 app.party_id 不變（不把設定留在交易裡）', async () => {
    const after = await withTx({ kind: 'control' }, async (tx) => {
      await tx.query('SELECT org.party_has_tenant_membership($1)', [pid(0)]);
      return (await tx.query<{ v: string | null }>(`SELECT current_setting('app.party_id', true) AS v`)).rows[0].v;
    });
    expect(after === null || after === '').toBe(true);
    const kept = await withTx({ kind: 'party', partyId: pid(1) }, async (tx) => {
      await tx.query('SELECT org.party_has_tenant_membership($1)', [pid(0)]);
      return (await tx.query<{ v: string }>(`SELECT current_setting('app.party_id', true) AS v`)).rows[0].v;
    });
    expect(kept).toBe(pid(1));
  });

  it('PUBLIC 不能執行，app_rw 能執行，且是固定 search_path 的定義者函式', async () => {
    const { rows } = await asRole(db, 'app_owner', () =>
      db.query<{ secdef: boolean; config: string[] | null; public_exec: boolean; rw_exec: boolean }>(
        `SELECT p.prosecdef AS secdef, p.proconfig AS config,
                has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
                has_function_privilege('app_rw', p.oid, 'EXECUTE') AS rw_exec
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'org' AND p.proname = 'party_has_tenant_membership'`,
      ),
    );
    expect(rows[0].secdef).toBe(true);
    expect(rows[0].config?.some((c) => c.startsWith('search_path='))).toBe(true);
    expect(rows[0].public_exec).toBe(false);
    expect(rows[0].rw_exec).toBe(true);
  });
});

import type { PGliteInterface } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashRequestCode } from '../mandate-requests/code';
import {
  STORED_STATUSES,
  effectiveStatus,
  occupiesUnits,
  type RequestFacts,
  type StoredStatus,
} from '../mandate-requests/status';
import { pgliteDriver } from './drivers';
import { asRole, createTestDb, type TestDb } from './test-harness';
import { newUlid } from './ulid';
import { createWithTx, type OrgTx, type Tx, type WithTx } from './with-tx';

// MIL-206：申請的表與函式。一律以 app_rw 從外部觀察；看 registry 的列或改資料時才用 asRole 換成 app_owner。
// 狀態判定在 SQL（registry.mandate_request_status_at）與 TypeScript（status.ts）各有一份，這裡逐格比對兩邊相同。

let testDb: TestDb;
let db: PGliteInterface;
let withTx: WithTx;
const owner = <T>(fn: () => Promise<T>) => asRole(db, 'app_owner', fn);

const practiceOrg = newUlid();
const ownerOrg = newUlid();
const otherPracticeOrg = newUlid();
const practiceParty = newUlid();
const ownerParty = newUlid();
const otherParty = newUlid();
const entityId = newUlid();

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(() => testDb.close());

beforeEach(async () => {
  db = await testDb.fresh();
  withTx = createWithTx(pgliteDriver(db));
  await owner(async () => {
    await db.query(
      `INSERT INTO control.orgs (id, name, kind) VALUES ($1, '甲業者', 'practice'), ($2, '王先生', 'owner'), ($3, '乙業者', 'practice')`,
      [practiceOrg, ownerOrg, otherPracticeOrg],
    );
    for (const [partyId, label] of [
      [practiceParty, 'practice'],
      [ownerParty, 'owner'],
      [otherParty, 'other'],
    ] as const) {
      await db.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, $2, $3)`, [partyId, `${label}@example.com`, label]);
    }
    await db.query(`INSERT INTO registry.practice_entities (id, tax_id, name, entity_type, org_id) VALUES ($1, '12345678', '甲業者有限公司', 'company', $2)`, [
      entityId,
      practiceOrg,
    ]);
    await db.query(
      `INSERT INTO registry.practice_licenses (id, entity_id, kind, state) VALUES ($1, $3, 'management', 'verified'), ($2, $3, 'master_lease', 'pending')`,
      [newUlid(), newUlid(), entityId],
    );
  });
});

const asPractice = <T>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: practiceOrg, partyId: practiceParty }, fn);
const NOW = new Date(Date.now() - 60 * 60 * 1000);
const hash = (n: string) => createHash('sha256').update(n).digest('hex');

const createRow = (tx: Tx, kind = 'management', code = 'code-1', draft: object | null = null, now = NOW) =>
  tx.query<{ request_id: string; kind: string; status: string; created_at: Date; link_expires_at: Date }>(
    'SELECT * FROM registry.create_mandate_request($1, $2, $3, $4::jsonb, $5)',
    [newUlid(), kind, hash(code), draft === null ? null : JSON.stringify(draft), now],
  );

let employmentSeq = 0;
/** 在指定的執業主體下備一位人員與任職（走 app_owner 直接寫）。預設是已驗證、任職中的租賃住宅管理人員。 */
async function seedManager(
  options: { entity?: string; state?: 'pending' | 'verified' | 'lapsed'; practitionerState?: 'pending' | 'verified' | 'lapsed'; kind?: string; validUntil?: string; endedOn?: string | null } = {},
): Promise<string> {
  employmentSeq += 1;
  const party = newUlid();
  const practitioner = newUlid();
  const employment = newUlid();
  const kind = options.kind ?? 'rental_housing_manager';
  const key = `${kind}:112:內授營:${String(100000 + employmentSeq)}`;
  await owner(async () => {
    await db.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, $2, $3)`, [party, `manager-${employmentSeq}@example.com`, `管理人員${employmentSeq}`]);
    await db.query(
      `INSERT INTO registry.practitioners (id, party_id, certificate_kind, cert_year, cert_word, cert_serial, certificate_key, issued_on, valid_until, state)
       VALUES ($1, $2, $3, '112', '內授營', $4, $5, '2024-03-01', $6, $7)`,
      [practitioner, party, kind, String(100000 + employmentSeq), key, options.validUntil ?? '2036-03-01', options.practitionerState ?? 'verified'],
    );
    await db.query(
      `INSERT INTO registry.practitioner_employments (id, practitioner_id, certificate_key, certificate_kind, entity_id, state, started_on, ended_on)
       VALUES ($1, $2, $3, $4, $5, $6, '2026-01-01', $7)`,
      [employment, practitioner, key, kind, options.entity ?? entityId, options.state ?? 'verified', options.endedOn ?? null],
    );
  });
  return employment;
}

describe('表與權限', () => {
  it('app_rw 對申請的兩張表沒有任何直接權限', async () => {
    for (const table of ['registry.mandate_requests', 'registry.mandate_request_units']) {
      for (const sql of [`SELECT 1 FROM ${table}`, `DELETE FROM ${table}`, `UPDATE ${table} SET request_id = request_id`]) {
        await expect(asPractice((tx) => tx.query(sql))).rejects.toThrow(/permission denied|不存在|column/);
      }
    }
  });

  it('app_rw 不能直接執行內部函式（狀態判定、被佔用的租賃單位）', async () => {
    await expect(asPractice((tx) => tx.query(`SELECT registry.mandate_request_status_at('pending_owner', now(), NULL, NULL, NULL, now())`))).rejects.toThrow(/permission denied/);
    await expect(asPractice((tx) => tx.query(`SELECT * FROM registry.occupied_rental_units($1, ARRAY[$2], now(), NULL)`, [ownerOrg, newUlid()]))).rejects.toThrow(/permission denied/);
  });

  it('申請的函式沒有碰案件成員與呼叫者關係：不寫 org.case_members，不讓 caller_relation 回 bound', async () => {
    const { rows } = await owner(() =>
      db.query<{ proname: string }>(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'registry' AND (p.proname LIKE '%mandate_request%' OR p.proname = 'occupied_rental_units')
            AND (p.prosrc ILIKE '%case_members%' OR p.prosrc ILIKE '%caller_relation%' OR p.prosrc ILIKE '%mandatary%')`,
      ),
    );
    expect(rows).toEqual([]);
  });

  it('所有申請函式都固定 search_path，PUBLIC 不能執行', async () => {
    const { rows } = await owner(() =>
      db.query<{ proname: string; fixed: boolean; public_exec: boolean }>(
        `SELECT p.proname,
                EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') AS fixed,
                has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'registry' AND (p.proname LIKE '%mandate_request%' OR p.proname = 'occupied_rental_units')`,
      ),
    );
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const r of rows) expect({ fn: r.proname, fixed: r.fixed, public_exec: r.public_exec }).toEqual({ fn: r.proname, fixed: true, public_exec: false });
  });
});

describe('registry.mandate_request_status_at 與 status.ts 的 effectiveStatus 逐格相同', () => {
  const T0 = new Date('2026-01-01T00:00:00Z');
  const hours = (n: number, from: Date = T0) => new Date(from.getTime() + n * 3_600_000);
  const submitted = hours(10);
  const accepted = hours(20);

  const facts = (status: StoredStatus, patch: Partial<RequestFacts> = {}): RequestFacts => ({
    status,
    linkExpiresAt: hours(168),
    submittedAt: status === 'pending_owner' ? null : submitted,
    acceptedAt: status === 'accepted' || status === 'ended' || status === 'completed' ? accepted : null,
    contractSentAt: null,
    ...patch,
  });

  // 每個期限的前一毫秒、當下、後一毫秒，加上期限前很早與很晚
  const probeTimes = [T0, hours(167), new Date(hours(168).getTime() - 1), hours(168), new Date(hours(168).getTime() + 1)].concat(
    [hours(10 + 168), new Date(hours(10 + 168).getTime() - 1), hours(20 + 720), new Date(hours(20 + 720).getTime() - 1), hours(20 + 721), hours(24 * 365)],
  );

  const variants: Array<[string, RequestFacts]> = [
    ...STORED_STATUSES.map((s): [string, RequestFacts] => [s, facts(s)]),
    ['accepted + 已送合約', facts('accepted', { contractSentAt: hours(30) })],
  ];

  it.each(variants)('%s：每個時間點，SQL 與 TypeScript 的結果相同', async (_name, f) => {
    for (const now of probeTimes) {
      const { rows } = await owner(() =>
        db.query<{ s: string }>('SELECT registry.mandate_request_status_at($1, $2, $3, $4, $5, $6) AS s', [
          f.status,
          f.linkExpiresAt,
          f.submittedAt,
          f.acceptedAt,
          f.contractSentAt,
          now,
        ]),
      );
      expect({ now: now.toISOString(), sql: rows[0].s }).toEqual({ now: now.toISOString(), sql: effectiveStatus(f, now) });
    }
  });

  it('佔用租賃單位的狀態：被佔用的就是待業者接受與已接受（SQL 的 occupied_rental_units 與 occupiesUnits 一致）', () => {
    expect(STORED_STATUSES.filter((s) => occupiesUnits(s))).toEqual(['pending_practice', 'accepted']);
  });
});

describe('registry.create_mandate_request', () => {
  it('通過驗證的業者：寫一列待屋主確認，連結 168 小時後失效，回傳不含碼', async () => {
    const { rows } = await asPractice((tx) => createRow(tx, 'management', 'a', { name: '代填' }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'management', status: 'pending_owner' });
    expect(rows[0].link_expires_at.getTime() - rows[0].created_at.getTime()).toBe(7 * 24 * 3_600_000);
    expect(JSON.stringify(rows)).not.toContain(hashRequestCode('a'));
  });

  it('業別沒有通過驗證（待驗證）：回零列，什麼都沒寫', async () => {
    const { rows } = await asPractice((tx) => createRow(tx, 'master_lease'));
    expect(rows).toEqual([]);
    expect((await owner(() => db.query('SELECT 1 FROM registry.mandate_requests'))).rows).toEqual([]);
  });

  it('不是業者的組織（沒有執業主體）：回零列', async () => {
    const { rows } = await withTx({ kind: 'org', orgId: ownerOrg, partyId: ownerParty }, (tx) => createRow(tx));
    expect(rows).toEqual([]);
  });

  it('別的業者呼叫，只會建在自己的執業主體下，不會建在甲業者下', async () => {
    await owner(async () => {
      await db.query(`INSERT INTO registry.practice_entities (id, tax_id, name, entity_type, org_id) VALUES ($1, '87654321', '乙業者有限公司', 'company', $2)`, [newUlid(), otherPracticeOrg]);
      await db.query(
        `INSERT INTO registry.practice_licenses (id, entity_id, kind, state) SELECT $1, e.id, 'management', 'verified' FROM registry.practice_entities e WHERE e.org_id = $2`,
        [newUlid(), otherPracticeOrg],
      );
    });
    const { rows } = await withTx({ kind: 'org', orgId: otherPracticeOrg, partyId: otherParty }, (tx) => createRow(tx));
    expect(rows).toHaveLength(1);
    const stored = (await owner(() => db.query<{ practice_org_id: string }>('SELECT practice_org_id FROM registry.mandate_requests'))).rows;
    expect(stored).toEqual([{ practice_org_id: otherPracticeOrg }]);
  });

  it('沒有組織脈絡、沒有成員（party）、營運者脈絡，一律被拒（42501）', async () => {
    await expect(withTx({ kind: 'control' }, (tx) => createRow(tx))).rejects.toMatchObject({ code: '42501' });
    await expect(withTx({ kind: 'org', orgId: practiceOrg }, (tx) => createRow(tx))).rejects.toMatchObject({ code: '42501' });
  });

  it('碼的雜湊格式與重複：不是 64 位 16 進位被拒；同一個雜湊不能用兩次', async () => {
    await expect(asPractice((tx) => tx.query(`SELECT * FROM registry.create_mandate_request($1, 'management', 'plain-code', NULL, $2)`, [newUlid(), NOW]))).rejects.toMatchObject({ code: '22023' });
    await asPractice((tx) => createRow(tx, 'management', 'dup'));
    await expect(asPractice((tx) => createRow(tx, 'management', 'dup'))).rejects.toMatchObject({ code: '23505' });
  });
});

describe('registry.mandate_request_link_view', () => {
  it('有效的碼回一列，其餘回零列；沒有組織脈絡（登入前）也能呼叫', async () => {
    const code = 'k'.repeat(43);
    await asPractice((tx) => tx.query('SELECT * FROM registry.create_mandate_request($1, $2, $3, NULL, $4)', [newUlid(), 'management', hashRequestCode(code), NOW]));
    const ok = await withTx({ kind: 'control' }, (t) => t.query('SELECT * FROM registry.mandate_request_link_view($1, $2)', [hashRequestCode(code), NOW]));
    expect(ok.rows).toHaveLength(1);
    expect(Object.keys(ok.rows[0] as object).sort()).toEqual(['expires_at', 'kind', 'practice_name', 'tax_id', 'verified_kinds']);
    const none = await withTx({ kind: 'control' }, (t) => t.query('SELECT * FROM registry.mandate_request_link_view($1, $2)', [hashRequestCode('z'.repeat(43)), NOW]));
    expect(none.rows).toEqual([]);
  });

  it('格式不符的雜湊與失效時間當下，回零列', async () => {
    const code = 'e'.repeat(43);
    const created = await asPractice((tx) => tx.query<{ link_expires_at: Date }>('SELECT * FROM registry.create_mandate_request($1, $2, $3, NULL, $4)', [newUlid(), 'management', hashRequestCode(code), NOW]));
    const expiresAt = created.rows[0].link_expires_at;
    const at = (now: Date) => withTx({ kind: 'control' }, (t) => t.query('SELECT * FROM registry.mandate_request_link_view($1, $2)', [hashRequestCode(code), now]));
    expect((await at(new Date(expiresAt.getTime() - 1))).rows).toHaveLength(1);
    expect((await at(expiresAt)).rows).toEqual([]);
    const bad = await withTx({ kind: 'control' }, (t) => t.query('SELECT * FROM registry.mandate_request_link_view($1, $2)', ['abc', NOW]));
    expect(bad.rows).toEqual([]);
  });
});

describe('registry.expire_mandate_requests', () => {
  it('p_now 晚於資料庫時間超過 5 分鐘被拒，不會清掉還沒失效的資料', async () => {
    const code = 'f'.repeat(43);
    await asPractice((tx) => tx.query('SELECT * FROM registry.create_mandate_request($1, $2, $3, $4::jsonb, $5)', [newUlid(), 'management', hashRequestCode(code), JSON.stringify({ name: 'x' }), NOW]));
    const future = new Date(Date.now() + 30 * 24 * 3_600_000);
    await expect(withTx({ kind: 'control' }, (t) => t.query('SELECT * FROM registry.expire_mandate_requests($1)', [future]))).rejects.toMatchObject({ code: '22023' });
    expect((await owner(() => db.query<{ draft: unknown }>('SELECT draft FROM registry.mandate_requests'))).rows[0].draft).not.toBeNull();
  });

  it('已失效的申請清掉代填資料與謄本，回傳該刪的檔案 key；沒失效的不動', async () => {
    const old = new Date(Date.now() - 10 * 24 * 3_600_000);
    const expiredId = newUlid();
    const freshId = newUlid();
    await asPractice(async (tx) => {
      await tx.query('SELECT * FROM registry.create_mandate_request($1, $2, $3, $4::jsonb, $5)', [expiredId, 'management', hash('old'), JSON.stringify({ name: '舊' }), old]);
      await tx.query('SELECT * FROM registry.create_mandate_request($1, $2, $3, $4::jsonb, $5)', [freshId, 'management', hash('new'), JSON.stringify({ name: '新' }), NOW]);
    });
    await owner(() =>
      db.query(`UPDATE registry.mandate_requests SET draft_transcript = '{"object_key":"org/x/registry-requests/y/transcript.pdf","file_name":"t.pdf"}'::jsonb WHERE id = $1`, [expiredId]),
    );
    const keys = await withTx({ kind: 'control' }, (t) => t.query<{ expire_mandate_requests: string }>('SELECT * FROM registry.expire_mandate_requests($1)', [new Date()]));
    expect(keys.rows.map((r) => r.expire_mandate_requests)).toEqual(['org/x/registry-requests/y/transcript.pdf']);
    const left = (await owner(() => db.query<{ id: string; draft: unknown; draft_transcript: unknown }>('SELECT id, draft, draft_transcript FROM registry.mandate_requests ORDER BY id'))).rows;
    expect(left.find((r) => r.id === expiredId)).toMatchObject({ draft: null, draft_transcript: null });
    expect(left.find((r) => r.id === freshId)!.draft).not.toBeNull();
    // 再呼叫一次，沒有東西可清
    const again = await withTx({ kind: 'control' }, (t) => t.query('SELECT * FROM registry.expire_mandate_requests($1)', [new Date()]));
    expect(again.rows).toEqual([]);
  });
});

describe('registry.occupied_rental_units：被佔用的租賃單位（有效的委託、有效的包租的接點）', () => {
  // 本票的來源只有進行中的申請。有效的委託（MIL-212）與有效的包租（MIL-211）在函式內的 UNION ALL 補上，
  // 下面的案例就是它們要沿用的行為：只讀呼叫者自己的資料，過期的不算，自己這份不算。
  const otherOwnerOrg = newUlid();
  const hours = (n: number, from: Date) => new Date(from.getTime() + n * 3_600_000);

  async function unit(orgId: string, partyId: string): Promise<string> {
    return withTx({ kind: 'org', orgId, partyId }, async (tx) => {
      const anchorId = newUlid();
      const unitId = newUlid();
      await tx.query('SELECT * FROM registry.create_pending_anchor($1, $2, $3)', [anchorId, unitId, '某地址']);
      await tx.query('INSERT INTO org.properties (id, org_id, rental_unit_id, name, address) VALUES ($1, $2, $3, $4, $5)', [newUlid(), orgId, unitId, '物件', '某地址']);
      return unitId;
    });
  }

  async function seed(
    status: string,
    units: string[],
    options: { ownerOrgId?: string; submittedAt?: Date; acceptedAt?: Date; contractSentAt?: Date } = {},
  ): Promise<string> {
    const id = newUlid();
    const created = hours(-24 * 60, NOW);
    const manager = ['accepted', 'ended', 'completed'].includes(status) ? await seedManager() : null;
    await owner(async () => {
      await db.query(
        `INSERT INTO registry.mandate_requests
           (id, kind, practice_org_id, entity_id, created_by_party_id, code_hash, status, created_at, link_expires_at,
            owner_org_id, claimed_at, submitted_at, withdrawn_at, accepted_at, contract_sent_at, manager_employment_id, closed_at, closed_by)
         VALUES ($1, 'management', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          id, practiceOrg, entityId, practiceParty, hash(id), status, created, hours(168, created),
          options.ownerOrgId ?? ownerOrg, created, options.submittedAt ?? created, status === 'withdrawn' ? created : null,
          options.acceptedAt ?? null, options.contractSentAt ?? null, manager,
          status === 'ended' || status === 'declined' ? created : null, status === 'ended' ? 'owner' : status === 'declined' ? 'practice' : null,
        ],
      );
      for (const u of units) await db.query('INSERT INTO registry.mandate_request_units (request_id, rental_unit_id) VALUES ($1, $2)', [id, u]);
    });
    return id;
  }

  const occupied = async (units: string[], exclude: string | null = null, orgId = ownerOrg) =>
    (
      await owner(() =>
        db.query<{ occupied_rental_units: string }>('SELECT * FROM registry.occupied_rental_units($1, $2::text[], $3, $4)', [orgId, units, NOW, exclude]),
      )
    ).rows
      .map((r) => r.occupied_rental_units)
      .sort();

  it('待業者接受（7 天內）與已接受（30 天內）佔用；過期、已收回、別的屋主組織的申請不佔用', async () => {
    await owner(() => db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, '李先生', 'owner')`, [otherOwnerOrg]));
    const [a, b, c, d, e, f, g] = await Promise.all(Array.from({ length: 7 }, () => unit(ownerOrg, ownerParty)));
    await seed('pending_practice', [a], { submittedAt: hours(-24, NOW) });
    await seed('accepted', [b], { submittedAt: hours(-24 * 10, NOW), acceptedAt: hours(-24 * 5, NOW) });
    await seed('pending_practice', [c], { submittedAt: hours(-24 * 8, NOW) });
    await seed('accepted', [d], { submittedAt: hours(-24 * 40, NOW), acceptedAt: hours(-24 * 31, NOW) });
    await seed('accepted', [e], { submittedAt: hours(-24 * 40, NOW), acceptedAt: hours(-24 * 31, NOW), contractSentAt: hours(-24 * 30, NOW) });
    await seed('withdrawn', [f], { submittedAt: hours(-24, NOW) });
    await seed('pending_practice', [g], { ownerOrgId: otherOwnerOrg, submittedAt: hours(-24, NOW) });
    const all = [a, b, c, d, e, f, g];
    expect(await occupied(all)).toEqual([a, b, e].sort());
    // 別的屋主組織自己看：只有它自己的申請算
    expect(await occupied(all, null, otherOwnerOrg)).toEqual([g]);
  });

  it('送出的那份申請不算自己', async () => {
    const [a] = [await unit(ownerOrg, ownerParty)];
    const id = await seed('pending_practice', [a], { submittedAt: hours(-1, NOW) });
    expect(await occupied([a])).toEqual([a]);
    expect(await occupied([a], id)).toEqual([]);
  });

  it('沒有任何申請的租賃單位不被佔用', async () => {
    expect(await occupied([await unit(ownerOrg, ownerParty), newUlid()])).toEqual([]);
  });
});

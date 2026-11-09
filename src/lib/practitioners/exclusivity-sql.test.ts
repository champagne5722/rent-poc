import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../pg/database';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import { setupPracticeKit, type Account, type PracticeKit } from '../practice-entities/test-kit';
import { classifyEmploymentCreation, type CertificateKind, type CreationVerdict, type OtherEmployment } from '../registry-rules';

// MIL-186：專任判定在資料庫內做（registry.exclusivity_verdict，0072），純函式 classifyEmploymentCreation 是規則的參考實作。
// 這裡固定兩者對同一組輸入的結論相同，避免兩份規則分歧。輸入涵蓋證書種類、別家任職的狀態、期間與所屬執業主體。
// 資料庫端經 create_employment 觀察結論，因為 exclusivity_verdict 不授權給 app_rw。

let t: PracticeKit;
let claimant: Account;
let today: string;
const entityOf: Record<'self' | 'b' | 'c', string> = { self: '', b: '', c: '' };
const certOf: Record<'rental_housing_manager' | 'real_estate_broker', { id: string; key: string }> = {
  rental_housing_manager: { id: newUlid(), key: 'rental_housing_manager:112:內授營:7770001' },
  real_estate_broker: { id: newUlid(), key: 'real_estate_broker:112:北市經:7770002' },
};

beforeAll(async () => {
  t = await setupPracticeKit();
  await t.reset();
  claimant = await t.practiceAccount('claimant@example.com');
  const b = await t.practiceAccount('b@example.com', { name: '乙公司', taxId: '22222222' });
  const c = await t.practiceAccount('c@example.com', { name: '丙公司', taxId: '33333333' });
  for (const [name, account] of [['self', claimant], ['b', b], ['c', c]] as const) {
    entityOf[name] = (await t.registry<{ id: string }>('SELECT id FROM registry.practice_entities WHERE org_id = $1', [account.orgId]))[0].id;
  }
  for (const [kind, cert] of Object.entries(certOf)) {
    const [, year, word, serial] = cert.key.split(':');
    await t.registry(
      `INSERT INTO registry.practitioners (id, party_id, certificate_kind, cert_year, cert_word, cert_serial, certificate_key, issued_on, valid_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '2024-03-01', '2030-03-01')`,
      [cert.id, claimant.partyId, kind, year, word, serial, cert.key],
    );
  }
  today = (await t.registry<{ d: string }>(`SELECT (now() AT TIME ZONE 'Asia/Taipei')::date::text AS d`))[0].d;
}, 120_000);
afterAll(() => t.close());

const addDays = (iso: string, days: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

interface Other {
  /** self 是宣稱方自己的執業主體，b、c 是別家。 */
  entity: 'self' | 'b' | 'c';
  state: 'pending' | 'verified' | 'lapsed';
  /** 與今天相差的天數。 */
  start: number;
  end: number | null;
}

async function seed(kind: CertificateKind, others: readonly Other[]): Promise<void> {
  for (const o of others) {
    const party = newUlid();
    const practitioner = newUlid();
    const key = certOf[kind as keyof typeof certOf].key;
    const [, year, word, serial] = key.split(':');
    await t.registry('INSERT INTO control.parties (id, email, display_name) VALUES ($1, $2, $3)', [party, `${party.toLowerCase()}@others.test`, '別人']);
    await t.registry(
      `INSERT INTO registry.practitioners (id, party_id, certificate_kind, cert_year, cert_word, cert_serial, certificate_key, issued_on, valid_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '2024-03-01', '2030-03-01')`,
      [practitioner, party, kind, year, word, serial, key],
    );
    await t.registry(
      `INSERT INTO registry.practitioner_employments (id, practitioner_id, certificate_key, certificate_kind, entity_id, state, started_on, ended_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date)`,
      [newUlid(), practitioner, key, kind, entityOf[o.entity], o.state, addDays(today, o.start), o.end === null ? null : addDays(today, o.end)],
    );
  }
}

async function clear(): Promise<void> {
  await t.registry(`DELETE FROM registry.practitioner_employments WHERE practitioner_id NOT IN (SELECT id FROM registry.practitioners WHERE party_id = $1)`, [claimant.partyId]);
  await t.registry(`DELETE FROM registry.practitioners WHERE party_id <> $1`, [claimant.partyId]);
}

class Rollback extends Error {
  constructor(readonly result: unknown) {
    super('rollback');
  }
}

interface CreateRow {
  employment_id: string | null;
  item_id: string | null;
  outcome: string;
  consent_required: boolean | null;
}

/** 以宣稱方的身分呼叫 create_employment，回傳列與建立了幾筆任職，然後回滾。 */
async function callCreate(kind: CertificateKind): Promise<{ row: CreateRow; created: number }> {
  const cert = certOf[kind as keyof typeof certOf];
  try {
    await withTx({ kind: 'org', orgId: claimant.orgId, partyId: claimant.partyId }, async (tx) => {
      const { rows } = await (tx as OrgTx).query<CreateRow>('SELECT * FROM registry.create_employment($1, $2, $3::date, $4)', [newUlid(), cert.id, today, newUlid()]);
      // app_rw 沒有表的權限，改用本人端函式數目前組織的任職
      const mine = await (tx as OrgTx).query<{ v: { employments: Array<{ practitioner_id: string }> } }>('SELECT registry.my_practitioner() AS v');
      throw new Rollback({ row: rows[0], created: mine.rows[0].v.employments.filter((e) => e.practitioner_id === cert.id).length });
    });
  } catch (error) {
    if (error instanceof Rollback) return error.result as { row: CreateRow; created: number };
    throw error;
  }
  throw new Error('不應該提交');
}

const verdictOf = (row: CreateRow): CreationVerdict => (row.outcome === 'blocked' ? 'blocked' : row.consent_required ? 'consent_required' : 'clear');

const reference = (kind: CertificateKind, others: readonly Other[]): CreationVerdict =>
  classifyEmploymentCreation({
    certificateKind: kind,
    entityId: 'self',
    today,
    otherEmployments: others.map(
      (o): OtherEmployment => ({ entityId: o.entity, state: o.state, periodStart: addDays(today, o.start), periodEnd: o.end === null ? null : addDays(today, o.end) }),
    ),
  });

const KINDS = ['rental_housing_manager', 'real_estate_broker'] as const;
const PERIODS: ReadonlyArray<readonly [string, number, number | null]> = [
  ['進行中，沒有結束日', -30, null],
  ['進行中，結束日在未來', -30, 30],
  ['已結束（結束日是昨天）', -60, -1],
  ['還沒開始（明天以後）', 5, null],
  ['今天是最後一天', -30, 0],
  ['今天是第一天', 0, null],
];

const scenarios: Array<{ title: string; others: Other[] }> = [{ title: '沒有任何別家任職', others: [] }];
for (const entity of ['self', 'b'] as const) {
  for (const state of ['pending', 'verified', 'lapsed'] as const) {
    for (const [label, start, end] of PERIODS) {
      scenarios.push({ title: `${entity === 'self' ? '自己這家' : '別家'}、${state}、${label}`, others: [{ entity, state, start, end }] });
    }
  }
}
scenarios.push(
  { title: '別家待驗證加別家已結束的已驗證', others: [{ entity: 'b', state: 'pending', start: -5, end: null }, { entity: 'c', state: 'verified', start: -60, end: -1 }] },
  { title: '自己這家已驗證加別家已驗證但還沒開始', others: [{ entity: 'self', state: 'verified', start: -5, end: null }, { entity: 'b', state: 'verified', start: 3, end: null }] },
  { title: '別家待驗證加別家已驗證進行中', others: [{ entity: 'b', state: 'pending', start: -5, end: null }, { entity: 'c', state: 'verified', start: -5, end: null }] },
);

describe.each(KINDS)('資料庫判定與純函式參考實作的結論相同：%s', (kind) => {
  // 管理人員同一證號最多一筆已驗證任職（部分唯一索引），多筆已驗證的情境只在經紀人員測
  const applicable = scenarios.filter((s) => kind === 'real_estate_broker' || s.others.filter((o) => o.state === 'verified').length <= 1);

  it.each(applicable.map((s) => [s.title, s] as const))('%s', async (_title, scenario) => {
    await clear();
    await seed(kind, scenario.others);
    const { row, created } = await callCreate(kind);
    const expected = reference(kind, scenario.others);
    expect(verdictOf(row), JSON.stringify(scenario.others)).toBe(expected);
    // 阻擋時什麼都不建，也沒有任職 ID
    if (expected === 'blocked') {
      expect(created).toBe(0);
      expect(row.employment_id).toBeNull();
    } else {
      expect(created).toBe(1);
      expect(row.employment_id).not.toBeNull();
    }
  });

  it('多筆已驗證的經紀人員任職也不影響結論', async () => {
    if (kind !== 'real_estate_broker') return;
    await clear();
    const others: Other[] = [{ entity: 'b', state: 'verified', start: -5, end: null }, { entity: 'c', state: 'verified', start: -5, end: null }];
    await seed(kind, others);
    expect(verdictOf((await callCreate(kind)).row)).toBe(reference(kind, others));
  });
});

describe('回傳的列只有結果，沒有別家任職的任何值', () => {
  it('列的欄位固定，結果代碼只有兩種', async () => {
    await clear();
    await seed('rental_housing_manager', [{ entity: 'b', state: 'verified', start: -400, end: null }]);
    const { row } = await callCreate('rental_housing_manager');
    expect(Object.keys(row).sort()).toEqual(['consent_required', 'employment_id', 'item_id', 'outcome']);
    expect(row.outcome).toBe('blocked');
    expect(JSON.stringify(row)).not.toContain(addDays(today, -400));
  });
});

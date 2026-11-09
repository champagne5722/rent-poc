import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from './database';
import { attackerPracticeOrg, attackerPracticeOrgWithEntity, attackerRegisterCertificate, CALLER_RELATIONS, setupDisclosureWorld, type DisclosureWorld } from './registry-disclosure-kit';
import { newUlid } from './ulid';
import type { DbContext, OrgTx } from './with-tx';

// MIL-186 的滲透測試：app_rw 沒有任何能單獨呼叫的入口，能取得「某個證書鍵在別家有沒有在職」。
//
// 專任判定在 submit_practitioner 與 create_employment 內（0072）。這裡用各種呼叫者關係直接呼叫，確認：
//   1. 單獨的查詢入口（employment_exclusivity_facts）已移除，內部判定函式 exclusivity_verdict 不授權給 app_rw。
//   2. 寫入路徑回給呼叫者的只有結論與自己的物件 ID，不含別家任職的日期、狀態、筆數與 ID。
//   3. 不能到達判定的呼叫者，真實與不存在的證書鍵得到逐值相同的回應。
// 殘餘風險（待法務確認）：能到達判定的呼叫者，仍能從「被阻擋」得知此證書鍵在別家有已驗證在職。
// 這與登錄時的阻擋訊息相同（ADR-0017 決議 7），規則寫在 src/lib/practice-registry/README.md 的「殘餘風險」。

let world: DisclosureWorld;
beforeAll(async () => {
  world = await setupDisclosureWorld();
}, 120_000);
afterAll(() => world?.close());

const keyOf = (kind: string, serial: string) => `${kind}:112:內授營:${serial}`;
const KEYS = {
  verifiedManager: keyOf('rental_housing_manager', '1234567'), // 陳怡君，北辰，已驗證在職
  pendingManager: keyOf('rental_housing_manager', '2000002'), // 吳家豪，任職待驗證
  lapsedManager: keyOf('rental_housing_manager', '2000004'), // 許文傑，任職已結束
  verifiedBroker: keyOf('real_estate_broker', '3000001'), // 趙經紀，雲頂，已驗證在職
  missing: keyOf('rental_housing_manager', '9999999'),
};

type Failure = { failed: true; code: string; message: string };
type Result = { failed: false; rows: Array<Record<string, unknown>> };

async function call(ctx: DbContext, sql: string, params: unknown[]): Promise<Result | Failure> {
  try {
    const rows = await withTx(ctx, async (tx) => (await (tx as OrgTx).query<Record<string, unknown>>(sql, params)).rows);
    return { failed: false, rows };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { failed: true, code: e.code ?? '', message: e.message ?? '' };
  }
}

const submitSql = 'SELECT * FROM registry.submit_practitioner($1, $2, $3, $4, $5, $6::date, $7::date, NULL, $8, $9)';
function submitParams(key: string): unknown[] {
  const [kind, year, word, serial] = key.split(':');
  return [newUlid(), kind, year, word, serial, '2023-03-01', '2029-12-31', 'pending', newUlid()];
}
const createSql = 'SELECT * FROM registry.create_employment($1, $2, $3::date, $4)';

/** 把結果正規化：物件 ID 是隨機的，只留「有沒有值」。 */
function normalize(result: Result | Failure): unknown {
  if (result.failed) return { failed: result.code, message: result.message };
  return result.rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(v) ? '<id>' : v])),
  );
}

const DATE_PATTERN = /\d{4}-\d{2}-\d{2}/;

/** 每種關係的呼叫脈絡，加上新開的執業主體組織（沒有執業主體登錄）。 */
async function everyContext(): Promise<Array<[string, DbContext]>> {
  const contexts: Array<[string, DbContext]> = CALLER_RELATIONS.map((r) => [r.name, r.context(world)]);
  contexts.push(['新開的執業主體組織', (await attackerPracticeOrg(world)).ctx]);
  contexts.push(['有執業主體登錄的新組織', (await attackerPracticeOrgWithEntity(world)).ctx]);
  return contexts;
}

describe('單獨的專任事實入口已不存在', () => {
  it('employment_exclusivity_facts 已移除', async () => {
    const rows = await world.live.owner<{ n: string }>(`SELECT count(*)::text AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'registry' AND p.proname = 'employment_exclusivity_facts'`);
    expect(rows[0].n).toBe('0');
  });

  it('exclusivity_verdict 存在，但 app_rw 與 PUBLIC 都沒有執行權', async () => {
    const rows = await world.live.owner<{ app_rw: boolean; public_has: boolean }>(
      `SELECT has_function_privilege('app_rw', p.oid, 'EXECUTE') AS app_rw,
              EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_has
         FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
        WHERE s.nspname = 'registry' AND p.proname = 'exclusivity_verdict'`,
    );
    expect(rows).toEqual([{ app_rw: false, public_has: false }]);
  });

  it('app_rw 能執行的 registry 函式裡，沒有一個以證書鍵為唯一參數', async () => {
    const rows = await world.live.owner<{ name: string }>(
      `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
        WHERE s.nspname = 'registry' AND has_function_privilege('app_rw', p.oid, 'EXECUTE')
          AND p.pronargs = 1 AND (pg_get_function_arguments(p.oid) ~* 'certificate_key|p_key')`,
    );
    expect(rows).toEqual([]);
  });

  it.each([
    ['employment_exclusivity_facts', 'SELECT * FROM registry.employment_exclusivity_facts($1)', (key: string) => [key]],
    ['exclusivity_verdict', 'SELECT registry.exclusivity_verdict($1, $2, NULL)', (key: string) => [key, 'rental_housing_manager']],
  ] as const)('直接呼叫 %s：每種呼叫者一律被拒，真實與不存在的證書鍵回應相同', async (_name, sql, args) => {
    for (const [label, ctx] of await everyContext()) {
      const real = await call(ctx, sql, [...args(KEYS.verifiedManager)]);
      const missing = await call(ctx, sql, [...args(KEYS.missing)]);
      expect(real.failed, `${label} 不得成功`).toBe(true);
      expect(normalize(real), label).toEqual(normalize(missing));
    }
  });
});

describe('寫入路徑：不能到達判定的呼叫者，真實與不存在的證書鍵回應相同', () => {
  it('屋主組織、營運者、無脈絡、已有同種證書的北辰成員、沒有執業主體登錄的組織', async () => {
    const unreachable = CALLER_RELATIONS.filter((r) => r.name !== 'unrelated').map((r) => [r.name, r.context(world)] as const);
    for (const [label, ctx] of unreachable) {
      const real = await call(ctx, submitSql, submitParams(KEYS.verifiedManager));
      const missing = await call(ctx, submitSql, submitParams(KEYS.missing));
      expect(normalize(real), `submit_practitioner：${label}`).toEqual(normalize(missing));
    }
    // 沒有執業主體登錄的組織：每次新開，因為成功登錄後狀態會變
    const noEntity = async (key: string) => call((await attackerPracticeOrg(world)).ctx, submitSql, submitParams(key));
    expect(normalize(await noEntity(KEYS.verifiedManager))).toEqual(normalize(await noEntity(KEYS.missing)));
  });

  it('create_employment：不是自己的證書一律被拒，與證書鍵無關', async () => {
    for (const [label, ctx] of await everyContext()) {
      const real = await call(ctx, createSql, [newUlid(), newUlid(), '2026-11-10', newUlid()]);
      expect(real.failed, `${label} 不得成功`).toBe(true);
      expect((real as Failure).code, label).toBe('42501');
    }
  });
});

describe('寫入路徑：回給呼叫者的只有結論', () => {
  it('第一次登錄，管理人員的證書鍵在別家有已驗證在職：被阻擋，什麼都不寫，回應沒有日期與別家 ID', async () => {
    const a = await attackerPracticeOrgWithEntity(world);
    const result = await call(a.ctx, submitSql, submitParams(KEYS.verifiedManager));
    expect(result.failed).toBe(false);
    const rows = (result as Result).rows;
    expect(rows).toEqual([{ practitioner_id: null, item_id: null, state: null, outcome: 'blocked' }]);
    expect(JSON.stringify(rows)).not.toMatch(DATE_PATTERN);
    expect(JSON.stringify(rows)).not.toContain(world.live.world.chen.employmentId);
    expect(await world.live.owner('SELECT 1 FROM registry.practitioners WHERE party_id = $1', [a.partyId])).toHaveLength(0);
  });

  it('待驗證、已結束與不存在的證書鍵：登錄成功，三者的回應相同，不能互相區分', async () => {
    const outcomes: unknown[] = [];
    for (const key of [KEYS.pendingManager, KEYS.lapsedManager, KEYS.missing]) {
      const a = await attackerPracticeOrgWithEntity(world);
      const result = await call(a.ctx, submitSql, submitParams(key));
      expect(result.failed, key).toBe(false);
      outcomes.push(normalize(result));
    }
    expect(outcomes[0]).toEqual([{ practitioner_id: '<id>', item_id: '<id>', state: 'pending', outcome: 'registered' }]);
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[2]).toEqual(outcomes[0]);
  });

  it('經紀人員的證書鍵在別家有已驗證在職：登錄不被阻擋，回應與不存在的證書鍵相同', async () => {
    const a = await attackerPracticeOrgWithEntity(world);
    const b = await attackerPracticeOrgWithEntity(world);
    const real = await call(a.ctx, submitSql, submitParams(KEYS.verifiedBroker));
    const missing = await call(b.ctx, submitSql, submitParams(keyOf('real_estate_broker', '9999999')));
    expect(normalize(real)).toEqual(normalize(missing));
  });

  async function ownCertificate(key: string): Promise<{ ctx: DbContext; certificateId: string }> {
    const a = await attackerPracticeOrgWithEntity(world);
    await attackerRegisterCertificate(world, a, key);
    const rows = await world.live.owner<{ id: string }>('SELECT id FROM registry.practitioners WHERE party_id = $1', [a.partyId]);
    return { ctx: a.ctx, certificateId: rows[0].id };
  }
  const create = (ctx: DbContext, certificateId: string) => call(ctx, createSql, [newUlid(), certificateId, '2026-11-10', newUlid()]);

  it('建立任職，管理人員：已驗證在職的證書鍵被阻擋，回應沒有日期、狀態與別家 ID', async () => {
    const { ctx, certificateId } = await ownCertificate(KEYS.verifiedManager);
    const result = await create(ctx, certificateId);
    expect(result.failed).toBe(false);
    const rows = (result as Result).rows;
    expect(rows).toEqual([{ employment_id: null, item_id: null, outcome: 'blocked', consent_required: false }]);
    expect(JSON.stringify(rows)).not.toMatch(DATE_PATTERN);
    expect(JSON.stringify(rows)).not.toContain(world.live.world.chen.employmentId);
  });

  it('建立任職，管理人員：待驗證、已結束與不存在的證書鍵得到相同的結果', async () => {
    const outcomes: unknown[] = [];
    for (const key of [KEYS.pendingManager, KEYS.lapsedManager, KEYS.missing]) {
      const { ctx, certificateId } = await ownCertificate(key);
      outcomes.push(normalize(await create(ctx, certificateId)));
    }
    expect(outcomes[0]).toEqual([{ employment_id: '<id>', item_id: '<id>', outcome: 'created', consent_required: false }]);
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[2]).toEqual(outcomes[0]);
  });

  it('建立任職，經紀人員：別家已有已驗證在職時，只多一個「要求同意書」的旗標，沒有別家的資料', async () => {
    const { ctx, certificateId } = await ownCertificate(KEYS.verifiedBroker);
    const result = await create(ctx, certificateId);
    expect(result.failed).toBe(false);
    const rows = (result as Result).rows;
    expect(normalize(result)).toEqual([{ employment_id: '<id>', item_id: '<id>', outcome: 'created', consent_required: true }]);
    expect(JSON.stringify(rows)).not.toMatch(DATE_PATTERN);
  });
});

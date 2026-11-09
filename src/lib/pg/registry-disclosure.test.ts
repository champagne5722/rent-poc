import { withTx } from './database';
import type { OrgTx } from './with-tx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  REGISTRY_FUNCTION_CASES,
  registryFunctionsWithoutDisclosure,
  type DisclosureVariant,
  type Exposure,
  type ExposureTable,
  type PiiField,
} from './rls-cases';
import {
  attackerAssign,
  attackerCaseOwner,
  attackerDraftOwner,
  attackerPracticeOrg,
  attackerRegisterCertificate,
  CALLER_RELATIONS,
  observe,
  setupDisclosureWorld,
  subjectFor,
  type Attacker,
  type DisclosureWorld,
  type Outcome,
} from './registry-disclosure-kit';

// 跨組織查詢函式的個資揭露矩陣（MIL-165，起因是 MIL-113 的第一版讓其他組織讀到證號原文與成員 email）。
//
// 規則全文在 src/lib/practice-registry/README.md 的「個資揭露矩陣」。簡述：
//   1. app_rw 能執行的每個 registry 函式必須登記揭露規則（src/lib/pg/rls-cases/ 各模組的 disclosure）。
//   2. 每個函式對每種呼叫者關係各有一列期望值：回應含哪些個資欄位，或被拒。
//   3. 呼叫者自己能建立的關係（建草稿合約、存指派、加案件成員、開執業主體組織），不得解鎖證號原文。
//   4. 沒有關係的組織探測真實對象與不存在的對象，回應逐值相同。
// 關係與測試資料在 registry-disclosure-kit.ts 的 CALLER_RELATIONS。

let world: DisclosureWorld;
beforeAll(async () => {
  world = await setupDisclosureWorld();
}, 120_000);
afterAll(() => world?.close());

const PII_ORDER: readonly PiiField[] = ['certificateNo', 'fullEmail', 'taxId', 'checkId', 'inactiveEmployment'];
const sortFields = (fields: readonly PiiField[]) => [...fields].sort((a, b) => PII_ORDER.indexOf(a) - PII_ORDER.indexOf(b));

const REGISTRY_FUNCTIONS_SQL = `SELECT n.nspname || '.' || p.proname AS name
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'registry' AND has_function_privilege('app_rw', p.oid, 'EXECUTE') ORDER BY 1`;

const expectedFor = (table: ExposureTable, relation: string): Exposure => table.by?.[relation] ?? table.default;
const describeOutcome = (o: Outcome) => (o.status === 'denied' ? 'denied' : sortFields(o.fields));

interface Probe {
  fn: string;
  variant: DisclosureVariant;
}

/** 有 call 的規則，統一成 variant。'none' 規則等於每種關係都不含任何個資。 */
function probesOf(): { matrix: Probe[]; none: Array<{ fn: string; variant: DisclosureVariant }> } {
  const matrix: Probe[] = [];
  const none: Array<{ fn: string; variant: DisclosureVariant }> = [];
  for (const [fn, fnCase] of Object.entries(REGISTRY_FUNCTION_CASES)) {
    const rule = fnCase.disclosure;
    if (rule.kind === 'matrix') {
      for (const variant of rule.variants) matrix.push({ fn, variant });
    } else if (rule.call) {
      none.push({ fn, variant: { label: '不揭露', call: rule.call, expected: { default: [] } } });
    }
  }
  return { matrix, none };
}
const { matrix: MATRIX_PROBES, none: NONE_PROBES } = probesOf();

const relationByName = (name: string) => CALLER_RELATIONS.find((r) => r.name === name)!;

/** 函式對某種關係有沒有已知缺口（目前行為與原則不符，已有人負責）。 */
const gapOf = (fn: string, relation: string): string | undefined => {
  const rule = REGISTRY_FUNCTION_CASES[fn].disclosure;
  return rule.kind === 'matrix' ? rule.knownGaps?.[relation] : undefined;
};

/** 以某個關係的呼叫者呼叫一種呼叫方式。 */
const run = (relation: string, variant: DisclosureVariant, real = true) =>
  observe(world, relationByName(relation).context(world), (tx) => variant.call(tx, world.fixture, subjectFor(world.fixture, variant.subject, real)));

describe('登記完整：app_rw 能執行的每個 registry 函式都有揭露規則', () => {
  const names = async () => (await world.live.owner<{ name: string }>(REGISTRY_FUNCTIONS_SQL)).map((r) => r.name);

  it('系統目錄列出的函式都登記了揭露規則（沒登記就失敗）', async () => {
    const missing = registryFunctionsWithoutDisclosure(await names());
    expect(missing, `這些 registry 函式沒有個資揭露規則，請到 src/lib/pg/rls-cases/ 對應模組的 registryFunctions 補 disclosure：${missing.join('、')}`).toEqual([]);
  });

  it('登記裡沒有已不存在的函式', async () => {
    const existing = new Set(await names());
    expect(Object.keys(REGISTRY_FUNCTION_CASES).filter((f) => !existing.has(f))).toEqual([]);
  });

  it('機制本身有效：沒登記的函式會被抓到', () => {
    expect(registryFunctionsWithoutDisclosure(['registry.signing_view', 'registry.function_that_is_not_registered'])).toEqual([
      'registry.function_that_is_not_registered',
    ]);
  });

  it('「不揭露」必須寫理由，矩陣必須至少有一種呼叫方式', () => {
    for (const [fn, fnCase] of Object.entries(REGISTRY_FUNCTION_CASES)) {
      const rule = fnCase.disclosure;
      expect({ fn, reason: rule.reason.trim().length > 0 }).toEqual({ fn, reason: true });
      if (rule.kind === 'matrix') expect({ fn, variants: rule.variants.length > 0 }).toEqual({ fn, variants: true });
    }
  });
});

describe('關係表與期望值表一致', () => {
  it('關係名稱不重複', () => {
    const names = CALLER_RELATIONS.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('期望值表與已知缺口只提到關係表裡有的關係（拿掉一種關係時，這裡列出還沒刪的列）', () => {
    const known = new Set(CALLER_RELATIONS.map((r) => r.name));
    const stale: string[] = [];
    for (const [fn, fnCase] of Object.entries(REGISTRY_FUNCTION_CASES)) {
      const rule = fnCase.disclosure;
      if (rule.kind !== 'matrix') continue;
      for (const variant of rule.variants) {
        for (const relation of Object.keys(variant.expected.by ?? {})) if (!known.has(relation)) stale.push(`${fn}（${variant.label}）的期望值：${relation}`);
      }
      for (const relation of Object.keys(rule.knownGaps ?? {})) if (!known.has(relation)) stale.push(`${fn} 的已知缺口：${relation}`);
    }
    expect(stale, '關係表已經沒有這些關係，請一併刪除').toEqual([]);
  });

  it('已知缺口都指向一張票', () => {
    for (const [fn, fnCase] of Object.entries(REGISTRY_FUNCTION_CASES)) {
      const rule = fnCase.disclosure;
      if (rule.kind !== 'matrix') continue;
      for (const [relation, note] of Object.entries(rule.knownGaps ?? {})) {
        expect({ fn, relation, hasTicket: /MIL-\d+/.test(note) }).toEqual({ fn, relation, hasTicket: true });
      }
    }
  });
});

describe('已知缺口仍然成立（缺口消失時這裡會失敗，請刪掉 knownGaps 並調整 bound 的期望值）', () => {
  // MIL-116：bound 回該執業主體全部成員（或全部已驗證人員）的真實 email，不限於被指派的人。
  // 指派只指向陳怡君，王建國（一般成員）與林志豪（已驗證但沒被指派）的 email 也被讀到。
  const assignedOnly = (fn: string) => {
    const variant = (REGISTRY_FUNCTION_CASES[fn].disclosure as { variants: readonly DisclosureVariant[] }).variants[0];
    return async (relation: string) => {
      const outcome = await run(relation, variant);
      return outcome.status === 'ok' ? outcome.text : '';
    };
  };
  it.each(['bound', 'boundByCase'])('party_signer_candidates 對 %s 讀得到沒被指派的成員的 email', async (relation) => {
    expect(await assignedOnly('registry.party_signer_candidates')(relation)).toContain(world.live.world.beichen.people.wang.email);
  });
  it.each(['bound', 'boundByCase'])('signing_view 對 %s 讀得到沒被指派的已驗證人員的 email', async (relation) => {
    expect(await assignedOnly('registry.signing_view')(relation)).toContain(world.live.world.beichen.people.lin.email);
  });
});

describe.each(MATRIX_PROBES.map((p) => [`${p.fn}：${p.variant.label}`, p] as const))('矩陣 %s', (_title, probe) => {
  it.each(CALLER_RELATIONS.map((r) => [r.name, r.label] as const))('%s（%s）', async (relation) => {
    const expected = expectedFor(probe.variant.expected, relation);
    const outcome = await run(relation, probe.variant);
    expect(describeOutcome(outcome), `${probe.fn} 對「${relationByName(relation).label}」`).toEqual(expected === 'denied' ? 'denied' : sortFields(expected));
  });
});

describe.each(NONE_PROBES.map((p) => [p.fn, p] as const))('不揭露 %s', (_fn, probe) => {
  it.each(CALLER_RELATIONS.map((r) => [r.name, r.label] as const))('%s（%s）不含任何個資欄位', async (relation) => {
    const outcome = await run(relation, probe.variant);
    expect(outcome.status === 'ok' ? outcome.fields : []).toEqual([]);
  });
});

describe('呼叫者自己能建立的關係讀不到證號原文', () => {
  it('期望值表：能自己建立的關係，沒有任何函式預期回證號原文', () => {
    const creatable = CALLER_RELATIONS.filter((r) => r.creatable).map((r) => r.name);
    const violations: string[] = [];
    for (const { fn, variant } of MATRIX_PROBES) {
      for (const relation of creatable) {
        const expected = expectedFor(variant.expected, relation);
        if (expected !== 'denied' && expected.includes('certificateNo')) violations.push(`${fn}（${variant.label}）對 ${relation}`);
      }
    }
    expect(violations, '這些關係是呼叫者自己能建立的，不得解鎖證號原文').toEqual([]);
  });

  const everyCall = [...MATRIX_PROBES, ...NONE_PROBES.map((p) => ({ fn: p.fn, variant: p.variant }))];
  /** 用攻擊者的脈絡呼叫每個函式，收集含證號原文的呼叫。 */
  async function certificateLeaks(a: Attacker): Promise<string[]> {
    const leaks: string[] = [];
    for (const { fn, variant } of everyCall) {
      for (const real of [true, false]) {
        const outcome = await observe(world, a.ctx, (tx) => variant.call(tx, world.fixture, subjectFor(world.fixture, variant.subject, real)));
        if (outcome.status === 'ok' && outcome.fields.includes('certificateNo')) leaks.push(`${fn}（${variant.label}）`);
      }
    }
    return leaks;
  }

  it('新開執業主體組織', async () => {
    expect(await certificateLeaks(await attackerPracticeOrg(world))).toEqual([]);
  });

  it('建草稿合約（選人階段），再存一筆指派（已指派）', async () => {
    const attacker = await attackerDraftOwner(world);
    expect(await certificateLeaks(attacker), '選人階段').toEqual([]);
    await attackerAssign(world, attacker);
    expect(await certificateLeaks(attacker), '存指派之後').toEqual([]);
  });

  it('建案件並加北辰成員為案件成員（已指派）', async () => {
    expect(await certificateLeaks(await attackerCaseOwner(world))).toEqual([]);
  });
});

describe('無關的組織探測真實對象與不存在的對象，回應逐值相同', () => {
  const subjectProbes = MATRIX_PROBES.filter((p) => p.variant.subject !== undefined);

  it('至少有一種呼叫方式帶探測對象', () => {
    expect(subjectProbes.length).toBeGreaterThan(0);
  });

  describe.each(subjectProbes.map((p) => [`${p.fn}：${p.variant.label}`, p] as const))('%s', (_title, probe) => {
    it.each(['unrelated', 'unrelatedOwner'])('%s', async (relation) => {
      // 已知缺口：上面的矩陣已經把目前的行為登記為期望值，這裡不重複失敗。缺口修好後刪掉 knownGaps
      if (gapOf(probe.fn, relation)) return;
      const real = await run(relation, probe.variant, true);
      const missing = await run(relation, probe.variant, false);
      expect(real, '真實對象與不存在的對象不得有差別').toEqual(missing);
    });
  });

  it('新開的執業主體組織也一樣', async () => {
    const attacker = await attackerPracticeOrg(world);
    for (const { fn, variant } of subjectProbes.filter((p) => !gapOf(p.fn, 'unrelated'))) {
      const call = (real: boolean) => observe(world, attacker.ctx, (tx) => variant.call(tx, world.fixture, subjectFor(world.fixture, variant.subject, real)));
      expect(await call(true), `${fn}（${variant.label}）`).toEqual(await call(false));
    }
  });
});

describe('用別人的證號自行登錄待審證書後呼叫專任事實，拿不到失效的任職', () => {
  const key = (serial: string) => `rental_housing_manager:112:內授營:${serial}`;
  const facts = (a: Attacker, certificateKey: string) =>
    withTx(a.ctx, (tx) => (tx as OrgTx).query<Record<string, unknown>>('SELECT * FROM registry.employment_exclusivity_facts($1)', [certificateKey]).then((r) => r.rows));

  it('任職已結束與待驗證的證書鍵得到空結果，與不存在的證書鍵相同', async () => {
    const attacker = await attackerPracticeOrg(world);
    await attackerRegisterCertificate(world, attacker, key('2000004'));
    // 已結束（許文傑）與待驗證（吳家豪）的任職
    expect(await facts(attacker, key('2000004'))).toEqual([]);
    expect(await facts(attacker, key('2000002'))).toEqual([]);
    expect(await facts(attacker, key('9999999'))).toEqual([]);
  });

  it('回傳的列只含判定需要的欄位，別家的列一律是已驗證', async () => {
    const attacker = await attackerPracticeOrg(world);
    await attackerRegisterCertificate(world, attacker, key('1234567'));
    const rows = await facts(attacker, key('1234567'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['ended_on', 'started_on', 'state', 'whose']);
      expect(row).toMatchObject({ whose: 'other', state: 'verified' });
    }
  });

  // 殘餘風險（待法務確認）：登錄動作本身也會得到「此證號已有在職紀錄」的阻擋結果（ADR-0017 決議 7），
  // 所以這裡揭露的資訊沒有比阻擋結果多。若之後改成不能直接呼叫此函式，這個案例要一併改。
  it('殘餘風險：已驗證在職的證書鍵，仍可與不存在的證書鍵區分', async () => {
    const attacker = await attackerPracticeOrg(world);
    expect(await facts(attacker, key('1234567'))).not.toEqual(await facts(attacker, key('9999999')));
  });
});

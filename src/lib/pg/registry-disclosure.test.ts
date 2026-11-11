import { withTx } from './database';
import { newUlid } from './ulid';
import type { DbContext, OrgTx } from './with-tx';
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
  attackerSeatOwner,
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

describe('MIL-200：簽章人員只從自家指派，合約指派不再綁定', () => {
  const beichen = () => world.live.world.beichen;

  it('擁有者組織的草稿合約指派指向北辰，讀不到北辰的任何人員資料', async () => {
    const view = await run('draftAssigned', (REGISTRY_FUNCTION_CASES['registry.signing_view'].disclosure as { variants: readonly DisclosureVariant[] }).variants[0]);
    expect(view.status === 'ok' ? JSON.parse(view.text)[0].v : null).toEqual({ licenses: [], practitioners: [] });
  });

  it('攻擊者建草稿合約、存一筆指向北辰的指派之後，讀北辰與讀不存在的執業主體，回應完全相同（空）', async () => {
    const attacker = await attackerDraftOwner(world);
    await attackerAssign(world, attacker);
    const read = (entityId: string, employmentId: string | null) =>
      observe(world, attacker.ctx, async (tx) => ({
        view: (await tx.query('SELECT registry.signing_view($1, $2) AS v', [entityId, employmentId])).rows,
        signers: (await tx.query('SELECT * FROM registry.party_signer_candidates($1, NULL)', [entityId])).rows,
        entities: (await tx.query('SELECT * FROM registry.list_practice_entities(NULL)')).rows,
      }));
    const real = await read(beichen().entityId, null);
    expect(real).toEqual(await read(newUlid(), null));
    expect(real.status === 'ok' ? real.fields : ['denied']).toEqual([]);
    const byEmployment = await read(beichen().entityId, world.live.world.chen.employmentId);
    expect(byEmployment).toEqual(await read(beichen().entityId, newUlid()));
    expect(byEmployment.status === 'ok' ? byEmployment.fields : ['denied']).toEqual([]);
  });

  it.each(['practitioner', 'broker'] as const)(
    '簽章席位成員不產生 bound：乙公司把同時是甲公司成員的人指派進 %s 席位，對甲公司的執業主體仍是 none',
    async (relation) => {
      const attacker = await attackerSeatOwner(world, relation);
      const read = (entityId: string, employmentId: string | null) =>
        observe(world, attacker.ctx, async (tx) => ({
          view: (await tx.query('SELECT registry.signing_view($1, $2) AS v', [entityId, employmentId])).rows,
          signers: (await tx.query('SELECT * FROM registry.party_signer_candidates($1, NULL)', [entityId])).rows,
          signerById: (await tx.query('SELECT * FROM registry.party_signer_candidates(NULL, $1)', [beichen().people.chen.membershipId])).rows,
        }));
      const real = await read(beichen().entityId, null);
      // 與「執業主體不存在」的回應逐值相同，而且沒有任何個資
      expect(real).toEqual(await read(newUlid(), null));
      expect(real.status === 'ok' ? real.fields : ['denied']).toEqual([]);
      expect(real.status === 'ok' ? real.text : '').not.toContain(beichen().people.chen.email);
      const view = await observe(world, attacker.ctx, (tx) => tx.query('SELECT registry.signing_view($1, NULL) AS v', [beichen().entityId]).then((r) => r.rows));
      expect(view.status === 'ok' ? JSON.parse(view.text)[0].v : null).toEqual({ licenses: [], practitioners: [] });
      const signers = await observe(world, attacker.ctx, (tx) => tx.query('SELECT * FROM registry.party_signer_candidates($1, NULL)', [beichen().entityId]).then((r) => r.rows));
      expect(signers.status === 'ok' ? signers.text : '').toBe('[]');
      const byEmployment = await read(beichen().entityId, world.live.world.chen.employmentId);
      expect(byEmployment).toEqual(await read(beichen().entityId, newUlid()));
      expect(byEmployment.status === 'ok' ? byEmployment.fields : ['denied']).toEqual([]);
    },
  );

  it('受託人綁定（bound）列出成員與任職時，email 一律遮罩', async () => {
    const signers = await observe(world, relationByName('bound').context(world), (tx) =>
      tx.query('SELECT * FROM registry.party_signer_candidates($1, NULL)', [beichen().entityId]).then((r) => r.rows),
    );
    const text = signers.status === 'ok' ? signers.text : '';
    expect(text).toContain('王');
    expect(text).not.toContain(beichen().people.wang.email);
    expect(text).toContain('***@');
  });

  it('own 列出成員與任職時 email 也遮罩，用 ID 查單筆才有真實 email', async () => {
    const own = relationByName('own').context(world);
    const listed = await observe(world, own, (tx) =>
      tx.query('SELECT * FROM registry.party_signer_candidates($1, NULL)', [beichen().entityId]).then((r) => r.rows),
    );
    expect(listed.status === 'ok' ? listed.text : '').not.toContain(beichen().people.wang.email);
    const single = await observe(world, own, (tx) =>
      tx.query('SELECT * FROM registry.party_signer_candidates(NULL, $1)', [beichen().people.wang.membershipId]).then((r) => r.rows),
    );
    expect(single.status === 'ok' ? single.text : '').toContain(beichen().people.wang.email);
    const view = await observe(world, own, (tx) =>
      tx.query('SELECT registry.signing_view($1, NULL) AS v', [beichen().entityId]).then((r) => r.rows),
    );
    expect(view.status === 'ok' ? view.text : '').not.toContain(beichen().people.chen.email);
  });

  it('其他組織用北辰的成員 ID 查單筆，回應與不存在的 ID 相同（空）', async () => {
    for (const relation of ['draftAssigned', 'unrelated', 'unrelatedOwner']) {
      const call = (id: string) =>
        observe(world, relationByName(relation).context(world), (tx) =>
          tx.query('SELECT * FROM registry.party_signer_candidates(NULL, $1)', [id]).then((r) => r.rows),
        );
      const real = await call(beichen().people.chen.membershipId);
      expect(real, relation).toEqual(await call(newUlid()));
      expect(real.status === 'ok' ? real.text : '', relation).toBe('[]');
    }
  });

  it('list_practice_entities 只列自己組織的執業主體：別家的名稱不出現', async () => {
    for (const relation of ['own', 'unrelated', 'unrelatedOwner', 'draftAssigned', 'bound']) {
      const outcome = await observe(world, relationByName(relation).context(world), (tx) =>
        tx.query('SELECT * FROM registry.list_practice_entities(NULL)').then((r) => r.rows),
      );
      const names = outcome.status === 'ok' ? (JSON.parse(outcome.text) as Array<{ entity_id: string }>).map((r) => r.entity_id) : [];
      if (relation === 'own') expect(names).toEqual([beichen().entityId]);
      else expect(names, relation).toEqual([]);
    }
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

  it('建案件並加北辰成員為一般案件成員，或指派進簽章席位', async () => {
    expect(await certificateLeaks(await attackerCaseOwner(world))).toEqual([]);
    expect(await certificateLeaks(await attackerSeatOwner(world, 'practitioner'))).toEqual([]);
    expect(await certificateLeaks(await attackerSeatOwner(world, 'broker'))).toEqual([]);
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

describe('直接查詢某個證書鍵在別家有沒有在職（MIL-186）：一律被拒，真實與不存在的證書鍵回應相同', () => {
  // 0072 移除 employment_exclusivity_facts，專任判定只在 submit_practitioner 與 create_employment 內讀別家的任職。
  // 寫入路徑的探測測試在 exclusivity-disclosure.test.ts。殘餘風險（待法務確認）寫在 README 的「殘餘風險」。
  const key = (serial: string) => `rental_housing_manager:112:內授營:${serial}`;
  const probe = async (ctx: DbContext, certificateKey: string) => {
    try {
      await withTx(ctx, (tx) => (tx as OrgTx).query('SELECT * FROM registry.employment_exclusivity_facts($1)', [certificateKey]));
      return { rejected: false as const };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      return { rejected: true as const, code: e.code, message: e.message };
    }
  };

  it.each(CALLER_RELATIONS.map((r) => [r.name, r.label] as const))('%s（%s）', async (relation) => {
    const ctx = relationByName(relation).context(world);
    const verified = await probe(ctx, key('1234567'));
    expect(verified.rejected, '已驗證在職的證書鍵必須查不到').toBe(true);
    expect(verified).toEqual(await probe(ctx, key('9999999')));
  });

  it('新開的執業主體組織，自行登錄待審證書之後也一樣', async () => {
    const attacker = await attackerPracticeOrg(world);
    await attackerRegisterCertificate(world, attacker, key('2000004'));
    const verified = await probe(attacker.ctx, key('1234567'));
    expect(verified.rejected).toBe(true);
    for (const serial of ['2000004', '2000002', '9999999']) expect(await probe(attacker.ctx, key(serial))).toEqual(verified);
  });
});

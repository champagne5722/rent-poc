import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { credentialStatusAt } from '../credential-status';
import {
  createSeedPracticeRegistry,
  getPracticeRegistry,
  REGISTRY_UNAVAILABLE_REASON,
  registerLivePracticeRegistry,
  resolvePracticeRegistry,
  type PracticeRegistry,
  type PractitionerQuery,
} from '.';
import { setupLiveKit, type LiveKit } from './live-test-kit';

// practiceRegistry 的契約測試。seed adapter 與真實 adapter（MIL-113）跑同一組。
// 回傳的候選必須帶齊可簽章的判定事實，執業人員的 email 取自帳號。

const TODAY = '2026-11-09';
const AT = '2026-11-09T12:00:00+08:00';

/** 兩個 adapter 各自的測試資料對應。契約只靠這些 ID 與欄位，不碰 adapter 內部。 */
interface Fixture {
  /** 北辰的組織看到的 registry。 */
  registry: PracticeRegistry;
  /**
   * 依執業主體取得「自家組織」看到的 registry。seed 是示範用假資料，不分組織，每個執業主體回同一個。
   * 真實 adapter 只回自家組織的資料（MIL-200），所以雲頂的資料要用雲頂的組織查。
   */
  registryFor(entityId: string): PracticeRegistry;
  /** seed 列出全部執業主體；真實 adapter 只列自家的。 */
  scope: 'global' | 'own';
  /** 兼營代管與包租、有多位專任管理人員的執業主體 */
  beichen: string;
  /** 只有經紀業別的執業主體 */
  yunding: string;
  /** 可簽章的專任管理人員，同時是北辰的當事人簽署人 */
  chen: string;
  /** 另一位專任管理人員，與陳怡君不是同一人 */
  lin: string;
  chenEmail: string;
  /** 專任旗標為否的候選：要求專任時不在清單，不要求專任時在清單 */
  nonFullTime: { entityId: string; id: string; certificateKinds: PractitionerQuery['certificateKinds']; licenseKind: PractitionerQuery['licenseKind'] };
  /** 登錄沒有證書的負責人。登錄資料沒有負責人欄位的 adapter 為 null。 */
  noCertificate: string | null;
  /** 證書已失效與任職已結束的人，查詢時點不可簽章 */
  unsignable: readonly string[];
  /** 經紀營業員 */
  salesAgent: string;
  broker: string;
}

function runContract(name: string, setup: () => Promise<Fixture> | Fixture) {
  describe(`${name} 符合 practiceRegistry 契約`, () => {
    let fx: Fixture;
    beforeAll(async () => {
      fx = await setup();
    });
    const MANAGER = { certificateKinds: ['rental_housing_manager'], fullTime: true, licenseKind: 'master_lease' } as const;

    it('依業別查執業主體', async () => {
      const masterLease = await fx.registry.listEntities({ licenseKind: 'master_lease' });
      expect(masterLease.map((e) => e.id)).toContain(fx.beichen);
      expect(masterLease.every((e) => e.licenseKinds.includes('master_lease'))).toBe(true);
      const brokerage = await fx.registryFor(fx.yunding).listEntities({ licenseKind: 'brokerage' });
      expect(brokerage.map((e) => e.id)).toEqual([fx.yunding]);
      if (fx.scope === 'global') expect((await fx.registry.listEntities()).length).toBeGreaterThan(masterLease.length);
      // 自家的執業主體以外的，真實 adapter 不列（MIL-200）
      else expect(masterLease.map((e) => e.id)).not.toContain(fx.yunding);
    });

    it('查得到的執業主體帶名稱與業別', async () => {
      const entity = await fx.registry.getEntity(fx.beichen);
      expect(entity).toMatchObject({ id: fx.beichen, name: expect.stringContaining('北辰') });
      expect(entity!.licenseKinds).toEqual(expect.arrayContaining(['management', 'master_lease']));
    });

    it('查不到的執業主體與簽署人回 null', async () => {
      expect(await fx.registry.getEntity('no-such')).toBeNull();
      expect(await fx.registry.getPartySigner('no-such')).toBeNull();
      expect(await fx.registry.getPractitioner('no-such', { licenseKind: 'master_lease' })).toBeNull();
    });

    it('當事人簽署人候選屬於該執業主體', async () => {
      const signers = await fx.registry.listPartySigners(fx.beichen);
      expect(signers.length).toBeGreaterThan(0);
      expect(signers.every((s) => s.entityId === fx.beichen && s.email.includes('@'))).toBe(true);
      // 列出時 email 可能是遮罩的（真實 adapter），用 ID 查單筆才是真實 email。其他欄位相同
      expect(await fx.registry.getPartySigner(signers[0].id)).toEqual({ ...signers[0], email: expect.stringContaining('@') });
    });

    it('執業人員候選只含符合證書種類與專任要求的人', async () => {
      const list = await fx.registry.listPractitioners(fx.beichen, MANAGER);
      const ids = list.map((p) => p.id);
      expect(ids).toContain(fx.chen);
      expect(ids).not.toContain(fx.nonFullTime.id);
      if (fx.noCertificate) expect(ids).not.toContain(fx.noCertificate);
      expect(list.every((p) => p.certificateKind === 'rental_housing_manager' && p.fullTime && p.entityId === fx.beichen)).toBe(true);
    });

    it('執業人員候選只含查詢時點可簽章的人：證書失效、任職結束的人不在清單內', async () => {
      const ids = (await fx.registry.listPractitioners(fx.beichen, MANAGER)).map((p) => p.id);
      for (const id of fx.unsignable) expect(ids).not.toContain(id);
      expect(ids).toEqual(expect.arrayContaining([fx.chen, fx.lin]));
    });

    it('經紀營業員不在經紀人候選內', async () => {
      const list = await fx.registryFor(fx.yunding).listPractitioners(fx.yunding, {
        certificateKinds: ['real_estate_broker'],
        fullTime: false,
        licenseKind: 'brokerage',
      });
      expect(list.map((p) => p.id)).toEqual([fx.broker]);
      expect(list.map((p) => p.id)).not.toContain(fx.salesAgent);
    });

    it('不要求專任時，專任旗標為否的人也會列出', async () => {
      const { entityId, id, certificateKinds, licenseKind } = fx.nonFullTime;
      const registry = fx.registryFor(entityId);
      const required = await registry.listPractitioners(entityId, { certificateKinds, fullTime: true, licenseKind });
      expect(required.map((p) => p.id)).not.toContain(id);
      const relaxed = await registry.listPractitioners(entityId, { certificateKinds, fullTime: false, licenseKind });
      expect(relaxed.map((p) => p.id)).toContain(id);
    });

    it('候選帶可簽章的判定事實，查詢時指定業別層', async () => {
      const chen = await fx.registry.getPractitioner(fx.chen, { licenseKind: 'master_lease' });
      expect(chen).not.toBeNull();
      expect(credentialStatusAt(chen!.credential, AT)).toEqual({ signable: true, renewalWindow: null });
      // 北辰沒有經紀業別：業別層不是 verified，不可簽章
      const asBroker = await fx.registry.getPractitioner(fx.chen, { licenseKind: 'brokerage' });
      expect(credentialStatusAt(asBroker!.credential, AT).signable).toBe(false);
    });

    it('判定事實帶三層最新核對紀錄 ID 的欄位與任職期間', async () => {
      const chen = await fx.registry.getPractitioner(fx.chen, { licenseKind: 'master_lease' });
      const { license, practitioner, employment } = chen!.credential;
      expect(license).toHaveProperty('latestCheckId');
      expect(practitioner).toMatchObject({ state: 'verified', validUntil: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
      expect(employment).toMatchObject({ state: 'verified', startsOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), endsOn: null });
    });

    it('執業人員的 email 是帳號 email', async () => {
      const chen = await fx.registry.getPractitioner(fx.chen, { licenseKind: 'master_lease' });
      expect(chen!.accountEmail).toBe(fx.chenEmail);
    });

    it('候選帶任職 ID 與證書號碼；沒有證書的人證號是 null（簽章紀錄用，MIL-70）', async () => {
      const chen = await fx.registry.getPractitioner(fx.chen, { licenseKind: 'master_lease' });
      expect(chen!.employmentId).toEqual(expect.any(String));
      expect(chen!.employmentId).not.toBe('');
      expect(chen!.certificateNo).toEqual(expect.any(String));
      if (fx.noCertificate) {
        const zhang = await fx.registry.getPractitioner(fx.noCertificate, { licenseKind: 'master_lease' });
        expect(zhang!.certificateNo).toBeNull();
      }
    });

    it('候選帶 partyId，同一個自然人在當事人簽署人與執業人員兩種身分的 partyId 相同（合併用，MIL-76）', async () => {
      const chen = await fx.registry.getPractitioner(fx.chen, { licenseKind: 'master_lease' });
      const signers = await fx.registry.listPartySigners(fx.beichen);
      const chenAsSigner = signers.find((s) => s.partyId === chen!.partyId);
      expect(chen!.partyId).toEqual(expect.any(String));
      expect(chen!.partyId).not.toBe('');
      expect(chenAsSigner?.partyId).toBe(chen!.partyId);
      expect(chenAsSigner?.entityId).toBe(chen!.entityId);
      // 不同的人 partyId 不同，包含同一執業主體內的其他人
      const others = signers.filter((s) => s.partyId !== chen!.partyId);
      expect(others.length).toBeGreaterThan(0);
      expect(others.every((s) => s.partyId !== chen!.partyId)).toBe(true);
      const lin = await fx.registry.getPractitioner(fx.lin, { licenseKind: 'master_lease' });
      expect(lin!.partyId).not.toBe(chen!.partyId);
    });

    it('getPractitioner 不套用資格條件，才能列出被拒的原因', async () => {
      const { id, licenseKind, entityId } = fx.nonFullTime;
      expect(await fx.registryFor(entityId).getPractitioner(id, { licenseKind })).toMatchObject({ fullTime: false });
      for (const unsignableId of fx.unsignable) {
        const candidate = await fx.registry.getPractitioner(unsignableId, { licenseKind: 'master_lease' });
        expect(candidate).not.toBeNull();
        expect(credentialStatusAt(candidate!.credential, AT).signable).toBe(false);
      }
      if (fx.noCertificate) {
        const zhang = await fx.registry.getPractitioner(fx.noCertificate, { licenseKind: 'master_lease' });
        expect(zhang).toMatchObject({ certificateKind: null, isResponsiblePerson: true });
      }
    });

    it('getPractitioner 回傳經紀營業員，讓呼叫端說明為什麼不得簽章', async () => {
      const sales = await fx.registryFor(fx.yunding).getPractitioner(fx.salesAgent, { licenseKind: 'brokerage' });
      expect(sales).toMatchObject({ certificateKind: 'real_estate_sales_agent' });
    });
  });
}

runContract('seed adapter', () => {
  const registry = createSeedPracticeRegistry({ today: () => TODAY });
  return {
  registry,
  registryFor: () => registry,
  scope: 'global',
  beichen: 'org-pe-beichen',
  yunding: 'org-pe-yunding',
  chen: 'pr-chen',
  lin: 'pr-lin',
  chenEmail: 'chen.yijun@beichen.example.com',
  nonFullTime: { entityId: 'org-pe-beichen', id: 'pr-wu', certificateKinds: ['rental_housing_manager'], licenseKind: 'master_lease' },
  noCertificate: 'pr-zhang',
  unsignable: ['pr-zhou', 'pr-xu'],
  salesAgent: 'pr-sun',
  broker: 'pr-zhao',
  };
});

let liveKit: LiveKit;
beforeAll(async () => {
  liveKit = await setupLiveKit();
});
afterAll(() => liveKit?.close());

runContract('真實 adapter（各執業主體自己的組織）', () => {
  const { world } = liveKit;
  const orgOf: Record<string, string> = {
    [world.beichen.entityId]: world.beichen.orgId,
    [world.yunding.entityId]: world.yunding.orgId,
    [world.xinghe.entityId]: world.xinghe.orgId,
  };
  return {
    // 自己的組織看得到自己的全部事實（MIL-200：不再有跨組織的選人）
    registry: liveKit.registryAs(world.beichen.orgId),
    registryFor: (entityId: string) => liveKit.registryAs(orgOf[entityId]),
    scope: 'own',
    beichen: world.beichen.entityId,
    yunding: world.yunding.entityId,
    chen: world.chen.employmentId,
    lin: world.lin.employmentId,
    chenEmail: world.beichen.people.chen.email,
    // 登錄的專任由已驗證的管理人員任職保證，所以「專任旗標為否」用經紀人：要求專任時不在清單
    nonFullTime: { entityId: world.yunding.entityId, id: world.zhao.employmentId, certificateKinds: ['real_estate_broker'], licenseKind: 'brokerage' },
    noCertificate: null,
    unsignable: [world.zhou.employmentId, world.xu.employmentId],
    salesAgent: world.sun.employmentId,
    broker: world.zhao.employmentId,
  };
});

describe('seed adapter 的假資料涵蓋各種判定結果', () => {
  const registry = createSeedPracticeRegistry({ today: () => TODAY });
  const statusOf = async (id: string) => {
    const p = await registry.getPractitioner(id, { licenseKind: 'master_lease' });
    return credentialStatusAt(p!.credential, AT);
  };

  it('陳怡君可簽章', async () => {
    expect(await statusOf('pr-chen')).toEqual({ signable: true, renewalWindow: null });
  });
  it('林志豪在換證窗口內，仍可簽章', async () => {
    expect(await statusOf('pr-lin')).toEqual({
      signable: true,
      renewalWindow: { validUntil: '2027-02-09', windowStartsOn: '2026-08-09' },
    });
  });
  it('周大衛證書已失效', async () => {
    expect(await statusOf('pr-zhou')).toMatchObject({ signable: false, issues: [{ code: 'practitioner_not_verified' }] });
  });
  it('許文傑任職已結束', async () => {
    expect(await statusOf('pr-xu')).toMatchObject({ signable: false, issues: [{ code: 'employment_ended' }] });
  });
  it('陳怡君同時是北辰的當事人簽署人，email 與執業人員相同', async () => {
    const [signer] = (await registry.listPartySigners('org-pe-beichen')).filter((s) => s.id === 'ps-chen');
    const chen = await registry.getPractitioner('pr-chen', { licenseKind: 'master_lease' });
    expect(signer.email).toBe(chen!.accountEmail);
  });
});

describe('resolvePracticeRegistry：正式金鑰下沒有真實 adapter 就不可用（ADR-0021）', () => {
  it('mock 與 sandbox（沒設 DOTTEDSIGN_VERIFY_SIGNERS）用 seed 假資料', () => {
    const result = resolvePracticeRegistry({ env: {} });
    expect(result).toMatchObject({ available: true, registry: { kind: 'seed' } });
  });

  it('正式金鑰（DOTTEDSIGN_VERIFY_SIGNERS=1）且沒有真實 adapter：不可用', () => {
    expect(resolvePracticeRegistry({ env: { DOTTEDSIGN_VERIFY_SIGNERS: '1' } })).toEqual({
      available: false,
      reason: REGISTRY_UNAVAILABLE_REASON,
    });
  });

  it('不從金鑰字串推斷：有 client id 與 secret 但沒設變數時，仍視為非正式', () => {
    const env = { DOTTEDSIGN_CLIENT_ID: 'live-id', DOTTEDSIGN_CLIENT_SECRET: 'live-secret' };
    expect(resolvePracticeRegistry({ env })).toMatchObject({ available: true, registry: { kind: 'seed' } });
  });

  it('有真實 adapter 時任何環境都用它', () => {
    const live = { ...createSeedPracticeRegistry(), kind: 'live' as const };
    expect(resolvePracticeRegistry({ env: { DOTTEDSIGN_VERIFY_SIGNERS: '1' }, live })).toEqual({
      available: true,
      registry: live,
    });
  });
});

describe('getPracticeRegistry：請求時接上真實 adapter（MIL-113）', () => {
  const run = (async () => {
    throw new Error('這個測試不查資料庫');
  }) as never;

  it('預設用真實 adapter，包含正式金鑰', () => {
    expect(getPracticeRegistry({}, { run })).toMatchObject({ available: true, registry: { kind: 'live' } });
    expect(getPracticeRegistry({ DOTTEDSIGN_VERIFY_SIGNERS: '1' }, { run })).toMatchObject({ available: true, registry: { kind: 'live' } });
  });

  it('PRACTICE_REGISTRY=seed 才用假資料', () => {
    expect(getPracticeRegistry({ PRACTICE_REGISTRY: 'seed' })).toMatchObject({ available: true, registry: { kind: 'seed' } });
  });

  it('PRACTICE_REGISTRY=seed 搭配正式金鑰：仍擋下，不會因為指定 seed 而放行', () => {
    expect(getPracticeRegistry({ PRACTICE_REGISTRY: 'seed', DOTTEDSIGN_VERIFY_SIGNERS: '1' })).toEqual({
      available: false,
      reason: REGISTRY_UNAVAILABLE_REASON,
    });
  });

  it('註冊的覆寫優先，取消註冊後還原', () => {
    const override = { ...createSeedPracticeRegistry(), kind: 'live' as const };
    registerLivePracticeRegistry(override);
    expect(getPracticeRegistry({ DOTTEDSIGN_VERIFY_SIGNERS: '1' })).toEqual({ available: true, registry: override });
    registerLivePracticeRegistry(null);
    expect(getPracticeRegistry({ PRACTICE_REGISTRY: 'seed', DOTTEDSIGN_VERIFY_SIGNERS: '1' })).toMatchObject({ available: false });
  });
});

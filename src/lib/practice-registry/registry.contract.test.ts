import { describe, expect, it } from 'vitest';
import { credentialStatusAt } from '../credential-status';
import {
  createSeedPracticeRegistry,
  getPracticeRegistry,
  REGISTRY_UNAVAILABLE_REASON,
  registerLivePracticeRegistry,
  resolvePracticeRegistry,
  type PracticeRegistry,
} from '.';

// practiceRegistry 的契約測試。C 線的真實 adapter 也要通過同一組（把 factory 換掉即可）。
// 回傳的候選必須帶齊可簽章的判定事實，執業人員的 email 取自帳號。

const TODAY = '2026-11-09';
const AT = '2026-11-09T12:00:00+08:00';

function runContract(name: string, factory: () => PracticeRegistry) {
  describe(`${name} 符合 practiceRegistry 契約`, () => {
    const MANAGER = { certificateKinds: ['rental_housing_manager'], fullTime: true, licenseKind: 'master_lease' } as const;

    it('依業別查執業主體', async () => {
      const registry = factory();
      const masterLease = await registry.listEntities({ licenseKind: 'master_lease' });
      expect(masterLease.map((e) => e.id)).toContain('org-pe-beichen');
      expect(masterLease.every((e) => e.licenseKinds.includes('master_lease'))).toBe(true);
      const brokerage = await registry.listEntities({ licenseKind: 'brokerage' });
      expect(brokerage.map((e) => e.id)).toEqual(['org-pe-yunding']);
      expect((await registry.listEntities()).length).toBeGreaterThan(masterLease.length);
    });

    it('查不到的執業主體與簽署人回 null', async () => {
      const registry = factory();
      expect(await registry.getEntity('no-such')).toBeNull();
      expect(await registry.getPartySigner('no-such')).toBeNull();
      expect(await registry.getPractitioner('no-such', { licenseKind: 'master_lease' })).toBeNull();
    });

    it('當事人簽署人候選屬於該執業主體', async () => {
      const registry = factory();
      const signers = await registry.listPartySigners('org-pe-beichen');
      expect(signers.length).toBeGreaterThan(0);
      expect(signers.every((s) => s.entityId === 'org-pe-beichen' && s.email.includes('@'))).toBe(true);
      expect(await registry.getPartySigner(signers[0].id)).toEqual(signers[0]);
    });

    it('執業人員候選只含符合證書種類與專任要求的人', async () => {
      const registry = factory();
      const list = await registry.listPractitioners('org-pe-beichen', MANAGER);
      const ids = list.map((p) => p.id);
      expect(ids).toContain('pr-chen');
      // 專任旗標為否、負責人沒有證書，都不在候選內
      expect(ids).not.toContain('pr-wu');
      expect(ids).not.toContain('pr-zhang');
      expect(list.every((p) => p.certificateKind === 'rental_housing_manager' && p.fullTime)).toBe(true);
    });

    it('經紀營業員不在經紀人候選內', async () => {
      const registry = factory();
      const list = await registry.listPractitioners('org-pe-yunding', {
        certificateKinds: ['real_estate_broker'],
        fullTime: false,
        licenseKind: 'brokerage',
      });
      expect(list.map((p) => p.id)).toEqual(['pr-zhao']);
    });

    it('不要求專任時，專任旗標為否的人也會列出', async () => {
      const registry = factory();
      const list = await registry.listPractitioners('org-pe-beichen', { ...MANAGER, fullTime: false });
      expect(list.map((p) => p.id)).toContain('pr-wu');
    });

    it('候選帶可簽章的判定事實，查詢時指定業別層', async () => {
      const registry = factory();
      const chen = await registry.getPractitioner('pr-chen', { licenseKind: 'master_lease' });
      expect(chen).not.toBeNull();
      expect(credentialStatusAt(chen!.credential, AT)).toEqual({ signable: true, renewalWindow: null });
      // 北辰沒有經紀業別：業別層不是 verified，不可簽章
      const asBroker = await registry.getPractitioner('pr-chen', { licenseKind: 'brokerage' });
      expect(credentialStatusAt(asBroker!.credential, AT).signable).toBe(false);
    });

    it('執業人員的 email 是帳號 email', async () => {
      const registry = factory();
      const chen = await registry.getPractitioner('pr-chen', { licenseKind: 'master_lease' });
      expect(chen!.accountEmail).toBe('chen.yijun@beichen.example.com');
    });

    it('getPractitioner 不套用資格條件，才能列出被拒的原因', async () => {
      const registry = factory();
      const wu = await registry.getPractitioner('pr-wu', { licenseKind: 'master_lease' });
      expect(wu).toMatchObject({ fullTime: false });
      const zhang = await registry.getPractitioner('pr-zhang', { licenseKind: 'master_lease' });
      expect(zhang).toMatchObject({ certificateKind: null, isResponsiblePerson: true });
    });
  });
}

runContract('seed adapter', () => createSeedPracticeRegistry({ today: () => TODAY }));

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

  it('getPracticeRegistry 註冊真實 adapter 後改用它，取消註冊後還原', () => {
    const live = { ...createSeedPracticeRegistry(), kind: 'live' as const };
    registerLivePracticeRegistry(live);
    expect(getPracticeRegistry({ DOTTEDSIGN_VERIFY_SIGNERS: '1' })).toMatchObject({ available: true });
    registerLivePracticeRegistry(null);
    expect(getPracticeRegistry({ DOTTEDSIGN_VERIFY_SIGNERS: '1' })).toMatchObject({ available: false });
  });
});

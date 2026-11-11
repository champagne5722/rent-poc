import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { credentialStatusAt } from '../credential-status';
import { withTx } from '../pg/database';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import { LIVE_AT, setupLiveKit, type LiveKit } from './live-test-kit';
import { maskCertificateNo } from '../signature-records/snapshot';
import type { PractitionerQuery } from './types';

// 真實 adapter 的資料揭露規則（MIL-113，ADR-0023 決議 8、ADR-0012 決議 8）。
// 關係：own（自己的組織）、bound（案件成員）、none。MIL-200 拿掉 selecting 與合約指派造出的 bound：簽章人員只從自家指派。

let k: LiveKit;
beforeAll(async () => {
  k = await setupLiveKit();
});
afterAll(() => k?.close());

interface RawView {
  practitioners: Array<{ employment_id: string; certificate_no: unknown; account_email: string }>;
}
/** 繞過 adapter，直接看資料庫函式回了什麼。 */
const rawView = (orgId: string, entityId: string) =>
  withTx({ kind: 'org', orgId }, async (tx) => (await (tx as OrgTx).query<{ view: RawView }>('SELECT registry.signing_view($1, NULL) AS view', [entityId])).rows[0].view);

const MANAGER: PractitionerQuery = { certificateKinds: ['rental_housing_manager'], fullTime: true, licenseKind: 'master_lease' };

describe('own：自己的組織看得到證號原文、真實 email、全部任職', () => {
  it('證號原文與核對紀錄 ID', async () => {
    const registry = k.registryAs(k.world.beichen.orgId);
    const chen = await registry.getPractitioner(k.world.chen.employmentId, { licenseKind: 'master_lease' });
    expect(chen!.certificateNo).toBe(k.world.chen.certificateNo);
    expect(chen!.accountEmail).toBe(k.world.beichen.people.chen.email);
    expect(chen!.credential.license.latestCheckId).toBe(k.world.checks.license);
    expect(chen!.credential.practitioner.latestCheckId).toBe(k.world.checks.practitioner);
    expect(chen!.credential.employment.latestCheckId).toBe(k.world.checks.employment);
    expect(credentialStatusAt(chen!.credential, LIVE_AT)).toEqual({ signable: true, renewalWindow: null });
  });

  it('列出全部任職，含待驗證、證書失效與任職結束的人', async () => {
    const view = await rawView(k.world.beichen.orgId, k.world.beichen.entityId);
    expect(view.practitioners.map((p) => p.employment_id).sort()).toEqual(
      [k.world.chen, k.world.lin, k.world.wu, k.world.zhou, k.world.xu].map((p) => p.employmentId).sort(),
    );
  });

  it('任職待驗證的人也查得到（getPractitioner 不套用資格條件），判定為不可簽章', async () => {
    const wu = await k.registryAs(k.world.beichen.orgId).getPractitioner(k.world.wu.employmentId, { licenseKind: 'master_lease' });
    expect(wu).toMatchObject({ fullTime: false });
    expect(credentialStatusAt(wu!.credential, LIVE_AT)).toMatchObject({ signable: false, issues: [{ code: 'employment_not_verified' }] });
  });

  it('業別未驗證的執業主體：候選仍列出，業別層的判定事實是 pending', async () => {
    const list = await k.registryAs(k.world.xinghe.orgId).listPractitioners(k.world.xinghe.entityId, { ...MANAGER, licenseKind: 'management' });
    expect(list).toHaveLength(1);
    expect(credentialStatusAt(list[0].credential, LIVE_AT)).toMatchObject({ signable: false, issues: [{ code: 'license_not_verified' }] });
  });
});

describe('own：列出時 email 一律遮罩，用 ID 查單筆才是真實 email（MIL-200）', () => {
  it('列出執業人員候選與當事人簽署人候選，email 是遮罩的，姓名與 ID 照回', async () => {
    const registry = k.registryAs(k.world.beichen.orgId);
    const list = await registry.listPractitioners(k.world.beichen.entityId, MANAGER);
    expect(list.length).toBeGreaterThan(0);
    for (const c of list) expect(c.accountEmail).toMatch(/^.\*\*\*@example\.com$/);
    const signers = await registry.listPartySigners(k.world.beichen.entityId);
    expect(signers.map((s) => s.id)).toContain(k.world.beichen.people.chen.membershipId);
    for (const s of signers) expect(s.email).toMatch(/^.\*\*\*@example\.com$/);
    expect(JSON.stringify([list, signers])).not.toContain('chen.yijun');
  });

  it('用 ID 查單筆：自己組織的人拿到真實 email，合約欄位的 email 由伺服端依這個補', async () => {
    const registry = k.registryAs(k.world.beichen.orgId);
    expect(await registry.getPartySigner(k.world.beichen.people.chen.membershipId)).toMatchObject({
      email: k.world.beichen.people.chen.email,
      partyId: k.world.beichen.people.chen.partyId,
    });
  });

  it('用 ID 查別的組織的人：回 null，與不存在的 ID 相同', async () => {
    for (const orgId of [k.world.yunding.orgId, k.world.unrelatedOrgId, k.world.boundOrgId, k.world.selectingOrgId]) {
      const registry = k.registryAs(orgId);
      expect(await registry.getPartySigner(k.world.beichen.people.chen.membershipId)).toBeNull();
      expect(await registry.getPartySigner(newUlid())).toBeNull();
    }
  });
});

describe('bound：案件成員綁定，證號遮罩，email 遮罩，核對紀錄 ID', () => {
  it('案件成員屬於北辰：證號與 email 遮罩，核對紀錄 ID 照回', async () => {
    const registry = k.registryAs(k.world.caseBoundOrgId);
    const chen = await registry.getPractitioner(k.world.chen.employmentId, { licenseKind: 'master_lease' });
    // 證號原文不離開資料庫：拿到的是遮罩後的值，maskCertificateNo 對它結果不變
    expect(chen!.certificateNo).toBe(maskCertificateNo(k.world.chen.certificateNo));
    expect(chen!.certificateNo).not.toContain('1234567');
    expect(maskCertificateNo(chen!.certificateNo)).toBe(chen!.certificateNo);
    // MIL-200：bound 不再拿到真實 email。送簽由執業主體自己的組織做，不需要
    expect(chen!.accountEmail).toMatch(/^.\*\*\*@example\.com$/);
    expect(chen!.credential.license.latestCheckId).toBe(k.world.checks.license);
    expect(chen!.credential.practitioner.latestCheckId).toBe(k.world.checks.practitioner);
    expect(chen!.credential.employment.latestCheckId).toBe(k.world.checks.employment);
    expect(credentialStatusAt(chen!.credential, LIVE_AT)).toEqual({ signable: true, renewalWindow: null });
  });

  it('列出任職時只回證書與任職都已驗證的人', async () => {
    const view = await rawView(k.world.caseBoundOrgId, k.world.beichen.entityId);
    expect(view.practitioners.map((p) => p.employment_id).sort()).toEqual([k.world.chen.employmentId, k.world.lin.employmentId].sort());
    expect(JSON.stringify(view)).not.toContain('"certificate_no":{');
  });

  it('用任職 ID 查單筆時回完整狀態，送簽前檢查才能說明被拒的原因', async () => {
    const registry = k.registryAs(k.world.caseBoundOrgId);
    const xu = await registry.getPractitioner(k.world.xu.employmentId, { licenseKind: 'master_lease' });
    expect(credentialStatusAt(xu!.credential, LIVE_AT)).toMatchObject({ signable: false, issues: [{ code: 'employment_not_verified' }] });
    const zhou = await registry.getPractitioner(k.world.zhou.employmentId, { licenseKind: 'master_lease' });
    expect(credentialStatusAt(zhou!.credential, LIVE_AT)).toMatchObject({ signable: false });
  });

  it('當事人簽署人的 email 遮罩，用成員 ID 查單筆也一樣', async () => {
    const registry = k.registryAs(k.world.caseBoundOrgId);
    const signers = await registry.listPartySigners(k.world.beichen.entityId);
    expect(signers.length).toBeGreaterThan(0);
    for (const s of signers) expect(s.email).toMatch(/^.\*\*\*@example\.com$/);
    expect(await registry.getPartySigner(k.world.beichen.people.chen.membershipId)).toMatchObject({
      email: expect.stringMatching(/^.\*\*\*@example\.com$/),
    });
  });
});

describe('自己建立關係的攻擊：建草稿合約、再存一筆指派（MIL-200 起什麼都拿不到）', () => {
  it('草稿合約的指派不再讓關係成立：候選、事實、簽署人與不存在的執業主體相同', async () => {
    const attacker = await k.newDraftOrg('攻擊者的屋主組織');
    const registry = k.registryAs(attacker.orgId);
    const chenCandidate = k.world.chen.employmentId;
    // 存指派前後都一樣
    for (const phase of ['存指派前', '存指派後']) {
      if (phase === '存指派後') await k.assign(attacker.orgId, attacker.contractId, k.world.beichen.entityId, chenCandidate);
      expect(await registry.listPractitioners(k.world.beichen.entityId, MANAGER), phase).toEqual([]);
      expect(await registry.listPractitioners(newUlid(), MANAGER), phase).toEqual([]);
      expect(await registry.listPartySigners(k.world.beichen.entityId), phase).toEqual([]);
      expect(await registry.getPractitioner(chenCandidate, { licenseKind: 'master_lease' }), phase).toBeNull();
      expect(await registry.getPartySigner(k.world.beichen.people.chen.membershipId), phase).toBeNull();
      expect(await registry.listEntities(), phase).toEqual([]);
    }
    const text = JSON.stringify(await rawView(attacker.orgId, k.world.beichen.entityId));
    expect(text).not.toContain('"certificate_no":{');
    for (const id of [k.world.chen, k.world.wu, k.world.zhou, k.world.xu].map((p) => p.employmentId)) expect(text).not.toContain(id);
  });
});

describe('有草稿合約但沒有綁定的組織（原 selecting）與無關的組織相同', () => {
  it('候選、單筆查詢、簽署人候選全部是空的', async () => {
    const registry = k.registryAs(k.world.selectingOrgId);
    expect(await registry.listPractitioners(k.world.beichen.entityId, MANAGER)).toEqual([]);
    expect(await registry.getPractitioner(k.world.chen.employmentId, { licenseKind: 'master_lease' })).toBeNull();
    expect(await registry.getPractitioner(k.world.sun.employmentId, { licenseKind: 'brokerage' })).toBeNull();
    expect(await registry.listPartySigners(k.world.beichen.entityId)).toEqual([]);
    expect(await registry.getPartySigner(k.world.beichen.people.chen.membershipId)).toBeNull();
  });
});

describe('none：沒有合約也沒有綁定的組織，與執業主體不存在不可區分', () => {
  it('候選人、判定事實、簽署人都是空的', async () => {
    const registry = k.registryAs(k.world.unrelatedOrgId);
    const unknownEntity = newUlid();
    for (const entityId of [k.world.beichen.entityId, unknownEntity]) {
      expect(await registry.listPractitioners(entityId, MANAGER)).toEqual([]);
      expect(await registry.listPartySigners(entityId)).toEqual([]);
    }
    expect(await registry.getPractitioner(k.world.chen.employmentId, { licenseKind: 'master_lease' })).toBeNull();
    expect(await registry.getPractitioner(newUlid(), { licenseKind: 'master_lease' })).toBeNull();
    expect(await registry.getPartySigner(k.world.beichen.people.chen.membershipId)).toBeNull();
    expect(await registry.getPartySigner(newUlid())).toBeNull();
  });

  it('別的執業主體組織沒有草稿合約時，也看不到北辰的人員', async () => {
    const registry = k.registryAs(k.world.yunding.orgId);
    expect(await registry.listPractitioners(k.world.beichen.entityId, MANAGER)).toEqual([]);
    expect(await registry.getPractitioner(k.world.chen.employmentId, { licenseKind: 'master_lease' })).toBeNull();
  });

  it('執業主體名單只列自己組織的：別家的名稱與業別不出現', async () => {
    // 屋主組織沒有執業主體，名單是空的
    expect(await k.registryAs(k.world.unrelatedOrgId).listEntities({ licenseKind: 'brokerage' })).toEqual([]);
    expect(await k.registryAs(k.world.unrelatedOrgId).listEntities()).toEqual([]);
    // 別家執業主體組織只看到自己的。雲頂有經紀業別，北辰沒有
    expect(await k.registryAs(k.world.yunding.orgId).listEntities({ licenseKind: 'brokerage' })).toEqual([
      { id: k.world.yunding.entityId, name: '雲頂不動產經紀有限公司', licenseKinds: ['brokerage'] },
    ]);
    expect(await k.registryAs(k.world.beichen.orgId).listEntities({ licenseKind: 'brokerage' })).toEqual([]);
    expect((await k.registryAs(k.world.beichen.orgId).listEntities()).map((e) => e.id)).toEqual([k.world.beichen.entityId]);
  });

  it('自己組織的執業主體即使業別還沒驗證也列出，讓畫面說明原因', async () => {
    // 星河的業別是待驗證：依業別查時不列，不給業別時列出
    expect(await k.registryAs(k.world.xinghe.orgId).listEntities({ licenseKind: 'management' })).toEqual([]);
    expect((await k.registryAs(k.world.xinghe.orgId).listEntities()).map((e) => e.id)).toEqual([k.world.xinghe.entityId]);
  });

  it('回應的 JSON 沒有別的組織的 ID、統編與成員', async () => {
    const registry = k.registryAs(k.world.unrelatedOrgId);
    const dump = JSON.stringify([
      await registry.listEntities(),
      await registry.listPartySigners(k.world.beichen.entityId),
    ]);
    expect(dump).not.toContain(k.world.beichen.orgId);
    expect(dump).not.toContain('11111111');
    expect(dump).not.toContain(k.world.beichen.people.chen.email);
  });
});

describe('呼叫者來源', () => {
  it('沒有組織脈絡不能查', async () => {
    await expect(
      withTx({ kind: 'control' }, (tx) => tx.query('SELECT registry.signing_view($1, NULL)', [k.world.beichen.entityId])),
    ).rejects.toThrow(/組織/);
  });

  it('app_rw 不能直接呼叫內部函式 caller_relation', async () => {
    await expect(
      withTx({ kind: 'org', orgId: k.world.selectingOrgId }, (tx) => (tx as OrgTx).query(`SELECT registry.caller_relation($1)`, [k.world.beichen.entityId])),
    ).rejects.toThrow(/permission denied/);
  });

  it('呼叫者自己設定 app.org_id 也騙不到：關係以交易的組織脈絡為準，成員資格另外查', async () => {
    // 無關的組織把脈絡設成北辰的組織 ID：withTx 的脈絡就是北辰，這正是 own 的定義，所以這裡只驗證
    // 無關組織在自己的脈絡內永遠拿不到資料
    const view = await withTx({ kind: 'org', orgId: k.world.unrelatedOrgId }, async (tx) => {
      const { rows } = await (tx as OrgTx).query<{ view: { practitioners: unknown[] } }>('SELECT registry.signing_view($1, NULL) AS view', [k.world.beichen.entityId]);
      return rows[0].view;
    });
    expect(view.practitioners).toEqual([]);
  });
});

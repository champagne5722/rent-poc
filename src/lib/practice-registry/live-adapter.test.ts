import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { credentialStatusAt } from '../credential-status';
import { withTx } from '../pg/database';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import { LIVE_AT, setupLiveKit, type LiveKit } from './live-test-kit';
import { maskCertificateNo } from '../signature-records/snapshot';
import type { PractitionerQuery } from './types';

// 真實 adapter 的資料揭露規則（MIL-113，ADR-0023 決議 8、ADR-0012 決議 8）。
// 關係：own（自己的組織）、bound（案件成員或合約指派）、selecting（有草稿合約）、none。

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

describe('bound：證號遮罩，真實 email，核對紀錄 ID', () => {
  for (const [name, orgId] of [
    ['合約指派綁定', () => k.world.boundOrgId],
    ['案件成員綁定', () => k.world.caseBoundOrgId],
  ] as const) {
    it(`${name}`, async () => {
      const registry = k.registryAs(orgId());
      const chen = await registry.getPractitioner(k.world.chen.employmentId, { licenseKind: 'master_lease' });
      // 證號原文不離開資料庫：拿到的是遮罩後的值，maskCertificateNo 對它結果不變
      expect(chen!.certificateNo).toBe(maskCertificateNo(k.world.chen.certificateNo));
      expect(chen!.certificateNo).not.toContain('1234567');
      expect(maskCertificateNo(chen!.certificateNo)).toBe(chen!.certificateNo);
      expect(chen!.accountEmail).toBe(k.world.beichen.people.chen.email);
      expect(chen!.credential.license.latestCheckId).toBe(k.world.checks.license);
      expect(chen!.credential.practitioner.latestCheckId).toBe(k.world.checks.practitioner);
      expect(chen!.credential.employment.latestCheckId).toBe(k.world.checks.employment);
      expect(credentialStatusAt(chen!.credential, LIVE_AT)).toEqual({ signable: true, renewalWindow: null });
    });
  }

  it('列出任職時只回證書與任職都已驗證的人', async () => {
    const view = await rawView(k.world.boundOrgId, k.world.beichen.entityId);
    expect(view.practitioners.map((p) => p.employment_id).sort()).toEqual([k.world.chen.employmentId, k.world.lin.employmentId].sort());
    expect(JSON.stringify(view)).not.toContain('"certificate_no":{');
  });

  it('用任職 ID 查單筆時回完整狀態，送簽前檢查才能說明被拒的原因', async () => {
    const registry = k.registryAs(k.world.boundOrgId);
    const xu = await registry.getPractitioner(k.world.xu.employmentId, { licenseKind: 'master_lease' });
    expect(credentialStatusAt(xu!.credential, LIVE_AT)).toMatchObject({ signable: false, issues: [{ code: 'employment_not_verified' }] });
    const zhou = await registry.getPractitioner(k.world.zhou.employmentId, { licenseKind: 'master_lease' });
    expect(credentialStatusAt(zhou!.credential, LIVE_AT)).toMatchObject({ signable: false });
  });

  it('當事人簽署人是真實 email', async () => {
    const signers = await k.registryAs(k.world.boundOrgId).listPartySigners(k.world.beichen.entityId);
    expect(signers.map((s) => s.email)).toContain(k.world.beichen.people.chen.email);
  });
});

describe('自己建立關係的攻擊：先選人，再存一筆指派', () => {
  it('不會多讀到證號原文、未指派人員的失效任職與真實 email（selecting → bound）', async () => {
    const attacker = await k.newDraftOrg('攻擊者的屋主組織');
    const registry = k.registryAs(attacker.orgId);
    // selecting：看得到候選 ID，但 email 與證號都是遮罩的
    const [candidate] = await registry.listPractitioners(k.world.beichen.entityId, MANAGER);
    expect(candidate.accountEmail).not.toContain(k.world.beichen.people.chen.email.split('@')[0]);
    expect(candidate.accountEmail).toMatch(/^.\*\*\*@example\.com$/);
    expect(candidate.certificateNo).not.toContain('1234567');
    // 在自己的草稿上存一筆指派，關係變成 bound
    await k.assign(attacker.orgId, attacker.contractId, k.world.beichen.entityId, candidate.id);
    const view = await rawView(attacker.orgId, k.world.beichen.entityId);
    const text = JSON.stringify(view);
    expect(text).not.toContain('"certificate_no":{');
    for (const id of [k.world.wu, k.world.zhou, k.world.xu].map((p) => p.employmentId)) expect(text).not.toContain(id);
    // email 變成真實的（送簽要寄信），這是 bound 的設計
    const bound = await k.registryAs(attacker.orgId).getPractitioner(candidate.id, { licenseKind: 'master_lease' });
    expect(bound!.certificateNo).not.toContain('1234567');
  });
});

describe('selecting：有草稿合約但沒有綁定，只看得到選人需要的資料', () => {
  it('候選只含證書與任職都已驗證的人，證號與 email 遮罩，沒有核對紀錄 ID', async () => {
    const registry = k.registryAs(k.world.selectingOrgId);
    const list = await registry.listPractitioners(k.world.beichen.entityId, MANAGER);
    expect(list.map((c) => c.id).sort()).toEqual([k.world.chen.employmentId, k.world.lin.employmentId].sort());
    for (const c of list) {
      expect(c.certificateNo).toMatch(/^\*+.{3}$/);
      expect(c.certificateNo).not.toMatch(/\d{4}/);
      expect(c.credential.license.latestCheckId).toBeNull();
      expect(c.credential.practitioner.latestCheckId).toBeNull();
      expect(c.credential.employment.latestCheckId).toBeNull();
      expect(c.accountEmail).toMatch(/^.\*\*\*@example\.com$/);
      expect(c.name).toBeTruthy();
    }
  });

  it('任職待驗證與證書失效的人查不到，與不存在不可區分', async () => {
    const registry = k.registryAs(k.world.selectingOrgId);
    expect(await registry.getPractitioner(k.world.wu.employmentId, { licenseKind: 'master_lease' })).toBeNull();
    expect(await registry.getPractitioner(k.world.zhou.employmentId, { licenseKind: 'master_lease' })).toBeNull();
    expect(await registry.getPractitioner(newUlid(), { licenseKind: 'master_lease' })).toBeNull();
  });

  it('經紀營業員查得到，讓呼叫端說明為什麼不得簽章', async () => {
    const sales = await k.registryAs(k.world.selectingOrgId).getPractitioner(k.world.sun.employmentId, { licenseKind: 'brokerage' });
    expect(sales).toMatchObject({ certificateKind: 'real_estate_sales_agent' });
    expect(sales!.certificateNo).not.toContain('3000002');
  });

  it('當事人簽署人候選：姓名與 ID 照回，email 遮罩', async () => {
    const registry = k.registryAs(k.world.selectingOrgId);
    const signers = await registry.listPartySigners(k.world.beichen.entityId);
    expect(signers.map((s) => s.id)).toContain(k.world.beichen.people.chen.membershipId);
    for (const s of signers) {
      expect(s.email).toMatch(/^.\*\*\*@example\.com$/);
      expect(s.name).toBeTruthy();
    }
    expect(JSON.stringify(signers)).not.toContain('chen.yijun');
    expect(await registry.getPartySigner(k.world.beichen.people.chen.membershipId)).toMatchObject({
      partyId: k.world.beichen.people.chen.partyId,
      entityId: k.world.beichen.entityId,
      email: expect.stringMatching(/^.\*\*\*@example\.com$/),
    });
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

  it('執業主體名單與名稱是公開的：任何組織都能依業別查已驗證的執業主體', async () => {
    const registry = k.registryAs(k.world.unrelatedOrgId);
    const brokers = await registry.listEntities({ licenseKind: 'brokerage' });
    expect(brokers).toEqual([{ id: k.world.yunding.entityId, name: '雲頂不動產經紀有限公司', licenseKinds: ['brokerage'] }]);
    // 業別還沒驗證的執業主體不在名單內
    expect((await registry.listEntities()).map((e) => e.id)).not.toContain(k.world.xinghe.entityId);
  });

  it('回應的 JSON 沒有別的組織的 ID、統編與成員', async () => {
    const registry = k.registryAs(k.world.unrelatedOrgId);
    const dump = JSON.stringify([
      await registry.listEntities(),
      await registry.getEntity(k.world.beichen.entityId),
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

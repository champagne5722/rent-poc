import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createContract, getContract } from '@/lib/contracts';
import { withTx } from '@/lib/pg/database';
import { actAsContext, TEST_PARTY_ID, TEST_USER_ID } from '@/lib/pg/route-test-kit';
import { newUlid } from '@/lib/pg/ulid';
import { createLivePracticeRegistry, registerLivePracticeRegistry, requestOrgRunner } from '@/lib/practice-registry';
import { setupLiveKit, type LiveKit } from '@/lib/practice-registry/live-test-kit';
import { NOT_OWN_ASSIGNMENT, NOT_OWN_PARTY_SIGNER, NOT_OWN_PRACTITIONER } from '@/lib/practitioner-assignment/service';
import type { ContractFields } from '@/lib/types';
import { GET, PUT } from './route';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

// MIL-200 滲透測試（票面第 13 條）：任何組織都只能指派自己組織的人，查別的組織的人，回應與查無資料相同。
// 用真實 adapter：登錄資料是 live-test-kit 的世界（北辰、雲頂、星河各有自己的組織），經 route 的公開回應觀察。
// 世界裡的專任管理人員陳怡君是北辰的人。雲頂（經紀業）與擁有者組織都是「別人」。

let live: LiveKit;
beforeAll(async () => {
  live = await setupLiveKit();
});
afterAll(async () => {
  registerLivePracticeRegistry(null);
  await live?.close();
});
afterEach(() => undefined);

const SLOT = 'lease.master_lease.practitioner';
const MASTER_LEASE_FIELDS = {
  routing: { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: false },
  landlordName: '',
  landlordEmail: '',
  tenantName: '王租客',
  tenantEmail: 'tenant@example.com',
} as unknown as ContractFields;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id: string) => GET(new NextRequest('http://localhost/api/contracts/x/practitioners'), ctx(id));
const put = (id: string, assignments: unknown) =>
  PUT(new NextRequest('http://localhost/api/contracts/x/practitioners', { method: 'PUT', body: JSON.stringify({ assignments }) }), ctx(id));
const snap = async (res: Response) => ({ status: res.status, body: await res.text() });

function actAsOrg(orgId: string, orgKind: 'owner' | 'practice'): void {
  // 執行器只解析一次請求脈絡，換組織就要換一個新的 adapter
  registerLivePracticeRegistry(createLivePracticeRegistry({ run: requestOrgRunner() }));
  actAsContext({ kind: 'org', orgId, orgKind, userId: TEST_USER_ID, partyId: TEST_PARTY_ID, role: 'admin', requestId: 'test' });
}

/** 在某個組織下建一份草稿合約（沒有案件），分流條件是包租。 */
async function draftIn(orgId: string): Promise<string> {
  return withTx({ kind: 'org', orgId }, (tx) => createContract(tx, { property_id: null, fields: MASTER_LEASE_FIELDS }));
}

const beichen = () => live.world.beichen;
const assignment = (over: Record<string, unknown>) => ({
  slot: SLOT,
  entityId: beichen().entityId,
  practitionerId: live.world.chen.employmentId,
  partySignerId: beichen().people.wang.membershipId,
  ...over,
});

/** 北辰的人員資料不得出現在別的組織收到的任何回應：名稱、ID、email。 */
function beichenLeaks(text: string): string[] {
  const w = live.world;
  const needles: Array<[string, string]> = [
    ['北辰的名稱', '北辰'],
    ['北辰的執業主體 ID', w.beichen.entityId],
    ['北辰的組織 ID', w.beichen.orgId],
    ['陳怡君的任職 ID', w.chen.employmentId],
    ['陳怡君', '陳怡君'],
    ['王建國', '王建國'],
    ['陳怡君的 email', w.beichen.people.chen.email],
    ['王建國的 email', w.beichen.people.wang.email],
    ['王建國的成員 ID', w.beichen.people.wang.membershipId],
  ];
  return needles.filter(([, value]) => text.includes(value)).map(([label]) => label);
}

describe('GET：選項只列自家組織的人，不含 email', () => {
  it.each([
    ['雲頂（別的執業主體組織）', () => live.world.yunding.orgId, 'practice'],
    ['星河（別的執業主體組織）', () => live.world.xinghe.orgId, 'practice'],
    ['擁有者組織', () => live.world.unrelatedOrgId, 'owner'],
    ['有草稿合約的擁有者組織', () => live.world.selectingOrgId, 'owner'],
  ] as const)('%s 讀不到北辰的任何資料', async (_label, orgOf, kind) => {
    const orgId = orgOf();
    actAsOrg(orgId, kind);
    const id = await draftIn(orgId);
    const res = await get(id);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(beichenLeaks(text)).toEqual([]);
    const body = JSON.parse(text) as { data: { options: { seats: Array<{ entities: Array<{ id: string }> }> } } };
    for (const seat of body.data.options.seats) expect(seat.entities.map((e) => e.id)).not.toContain(beichen().entityId);
  });

  it('自家組織：看得到自己的人，只有姓名，整個回應沒有任何 email', async () => {
    actAsOrg(beichen().orgId, 'practice');
    const id = await draftIn(beichen().orgId);
    const text = await (await get(id)).text();
    const options = (JSON.parse(text) as { data: { options: { seats: Array<{ entities: Array<{ id: string; partySigners: Array<{ name: string }>; practitioners: Array<{ id: string }> }> }> } } }).data.options;
    const entity = options.seats[0].entities.find((e) => e.id === beichen().entityId)!;
    expect(entity.partySigners.map((s) => s.name)).toContain('王建國');
    expect(entity.practitioners.map((p) => p.id)).toContain(live.world.chen.employmentId);
    expect(text).not.toMatch(/@/);
  });
});

describe('PUT：別的組織的人與不存在的人，回應逐位元相同', () => {
  async function attackAs(orgId: string, kind: 'owner' | 'practice', body: unknown): Promise<{ status: number; body: string }> {
    actAsOrg(orgId, kind);
    const id = await draftIn(orgId);
    return snap(await put(id, body));
  }

  it('用北辰的執業主體 ID：與不存在的執業主體相同', async () => {
    for (const [orgId, kind] of [
      [live.world.yunding.orgId, 'practice'],
      [live.world.unrelatedOrgId, 'owner'],
    ] as const) {
      const real = await attackAs(orgId, kind, [assignment({})]);
      const fake = await attackAs(orgId, kind, [assignment({ entityId: newUlid(), practitionerId: newUlid(), partySignerId: newUlid() })]);
      expect(real.status).toBe(400);
      expect(real).toEqual(fake);
      expect(real.body).toContain(NOT_OWN_ASSIGNMENT);
      expect(beichenLeaks(real.body)).toEqual([]);
    }
  });

  it('用北辰的任職 ID 與成員 ID，配自己組織的執業主體：與不存在的任職、成員相同', async () => {
    // 北辰自己的組織，執業主體是自家的，人員或簽署人換成雲頂的：與不存在的人員、簽署人相同
    const attackAsBeichen = async (over: Record<string, unknown>) => {
      actAsOrg(beichen().orgId, 'practice');
      const id = await draftIn(beichen().orgId);
      return snap(await put(id, [assignment(over)]));
    };
    const foreignEmployment = await attackAsBeichen({ practitionerId: live.world.zhao.employmentId });
    const missingEmployment = await attackAsBeichen({ practitionerId: newUlid() });
    expect(foreignEmployment.status).toBe(400);
    expect(foreignEmployment).toEqual(missingEmployment);
    expect(foreignEmployment.body).toContain(NOT_OWN_PRACTITIONER);

    const foreignSigner = await attackAsBeichen({ partySignerId: live.world.yunding.people.zhao.membershipId });
    const missingSigner = await attackAsBeichen({ partySignerId: newUlid() });
    expect(foreignSigner.status).toBe(400);
    expect(foreignSigner).toEqual(missingSigner);
    expect(foreignSigner.body).toContain(NOT_OWN_PARTY_SIGNER);
  });

  it('攻擊者什麼都沒存下：被拒絕之後合約的指派與欄位都沒變', async () => {
    actAsOrg(live.world.yunding.orgId, 'practice');
    const id = await draftIn(live.world.yunding.orgId);
    await put(id, [assignment({})]);
    const saved = await withTx({ kind: 'org', orgId: live.world.yunding.orgId }, async (tx) => ({
      assignments: (await tx.query('SELECT 1 FROM org.contract_practitioner_assignments WHERE contract_id = $1', [id])).rows,
      contract: await getContract(tx, id),
    }));
    expect(saved.assignments).toEqual([]);
    expect(saved.contract?.fields).toMatchObject({ landlordName: '', landlordEmail: '' });
  });
});

describe('PUT：自家組織指派成功，email 由伺服端補進合約欄位', () => {
  it('合約欄位的甲方姓名與 email 是所選當事人簽署人的，回應沒有 email', async () => {
    actAsOrg(beichen().orgId, 'practice');
    const id = await draftIn(beichen().orgId);
    const res = await put(id, [assignment({})]);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toMatch(/@/);
    const contract = await withTx({ kind: 'org', orgId: beichen().orgId }, (tx) => getContract(tx, id));
    expect(contract?.fields).toMatchObject({ landlordName: '王建國', landlordEmail: beichen().people.wang.email });
  });

  it('送簽前評估通過：合約欄位與所選的人一致', async () => {
    actAsOrg(beichen().orgId, 'practice');
    const id = await draftIn(beichen().orgId);
    await put(id, [assignment({})]);
    const body = (await (await get(id)).json()) as { data: { evaluation: { reasons: Array<{ code: string }> } } };
    expect(body.data.evaluation.reasons.map((r) => r.code)).not.toContain('party_signer_mismatch');
    expect(body.data.evaluation.reasons.map((r) => r.code)).not.toContain('practitioner_not_found');
  });
});

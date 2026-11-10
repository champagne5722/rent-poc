import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTx } from '../pg/database';
import { setupRouteDb, TEST_PARTY_ID, type RouteDb } from '../pg/route-test-kit';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import { createSubletUnit } from '../properties';
import { canCreateCase, canSendContract, type OwnershipGate } from './gate';
import { getOwnershipGate, precheckSubmission, recordTranscriptConsent, submitTranscript } from './repository';
import { advanceOwnership, createPropertyAt, lapseOwnership } from './test-kit';

// MIL-205：getOwnershipGate 是建立案件與送簽的唯一讀取入口。連線是 PGlite 的 app_rw，RLS 生效。
// 接縫是函式本身：給租賃單位，回這個組織的節點狀態與送件的文件事實。

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(() => kit.reset());

const inOrg = <T>(orgId: string, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId, partyId: TEST_PARTY_ID }, fn);

const unitOf = (orgId: string, propertyId: string) =>
  inOrg(orgId, async (tx) => (await tx.query<{ rental_unit_id: string }>('SELECT rental_unit_id FROM org.properties WHERE id = $1', [propertyId])).rows[0].rental_unit_id);

const gateOf = async (orgId: string, propertyId: string): Promise<OwnershipGate> => {
  const unitId = await unitOf(orgId, propertyId);
  return inOrg(orgId, (tx) => getOwnershipGate(tx, unitId));
};

describe('getOwnershipGate', () => {
  it('剛登錄、沒有節點：狀態是 null，建立案件與送簽都不放行', async () => {
    const id = await createPropertyAt(kit, 'unsubmitted');
    const gate = await gateOf(kit.orgA, id);
    expect(gate).toEqual({ nodeStatus: null, node: null });
    expect(canCreateCase(gate)).toBe(false);
    expect(canSendContract(gate)).toBe(false);
  });

  it.each([
    { stage: 'pending_verification', ok: false },
    { stage: 'failed', ok: false },
    { stage: 'verified', ok: true },
  ] as const)('節點是 $stage：放行 $ok', async ({ stage, ok }) => {
    const id = await createPropertyAt(kit, stage);
    const gate = await gateOf(kit.orgA, id);
    expect(gate.nodeStatus).toBe(stage);
    expect(gate.node?.hasSubmission).toBe(true);
    expect(canCreateCase(gate)).toBe(ok);
    expect(canSendContract(gate)).toBe(ok);
  });

  it('節點已失效：回 lapsed（不是 null），不放行', async () => {
    const id = await createPropertyAt(kit, 'verified');
    await lapseOwnership(kit, id);
    const gate = await gateOf(kit.orgA, id);
    expect(gate.nodeStatus).toBe('lapsed');
    expect(canCreateCase(gate)).toBe(false);
  });

  it('只讀自己組織的節點：別的組織的租賃單位與不存在的租賃單位，結果和沒有節點相同', async () => {
    const id = await createPropertyAt(kit, 'verified');
    const unitId = await unitOf(kit.orgA, id);
    expect(await inOrg(kit.orgB, (tx) => getOwnershipGate(tx, unitId))).toEqual({ nodeStatus: null, node: null });
    expect(await inOrg(kit.orgA, (tx) => getOwnershipGate(tx, '00000000000000000000000000'))).toEqual({ nodeStatus: null, node: null });
  });

  it('別的組織的節點已驗證，這個組織自己的節點不受影響', async () => {
    const a = await createPropertyAt(kit, 'verified', { orgId: kit.orgA });
    const b = await createPropertyAt(kit, 'pending_verification', { orgId: kit.orgB });
    expect((await gateOf(kit.orgA, a)).nodeStatus).toBe('verified');
    expect((await gateOf(kit.orgB, b)).nodeStatus).toBe('pending_verification');
  });

  it('分租單位與整戶共用一個節點：整戶已驗證，分租單位就放行', async () => {
    const whole = await createPropertyAt(kit, 'verified');
    const sublet = await inOrg(kit.orgA, (tx) => createSubletUnit(tx, whole, { label: '301', floor: null, name: null, type: null, confirmed: false }));
    if (sublet.kind !== 'created') throw new Error('沒建出分租單位');
    expect((await gateOf(kit.orgA, sublet.id)).nodeStatus).toBe('verified');
  });

  it('分租單位與整戶共用一個節點：整戶沒有通過，分租單位也不放行', async () => {
    const whole = await createPropertyAt(kit, 'pending_verification');
    const sublet = await inOrg(kit.orgA, (tx) => createSubletUnit(tx, whole, { label: '301', floor: null, name: null, type: null, confirmed: false }));
    if (sublet.kind !== 'created') throw new Error('沒建出分租單位');
    expect(canCreateCase(await gateOf(kit.orgA, sublet.id))).toBe(false);
  });

  it('謄本顯示信託登記：回四項資料都有；沒有信託是空的', async () => {
    const plain = await createPropertyAt(kit, 'verified');
    expect((await gateOf(kit.orgA, plain)).node).toMatchObject({ trustRegistered: false, trustItemsProvided: [] });

    const trusted = await createPropertyAt(kit, 'unsubmitted');
    await inOrg(kit.orgA, async (tx) => {
      await recordTranscriptConsent(tx, trusted, TEST_PARTY_ID, 'agree');
      const pre = await precheckSubmission(tx, trusted, TEST_PARTY_ID);
      if (!pre.ok) throw new Error(pre.reason);
      const fileId = newUlid();
      await submitTranscript(
        tx,
        pre.anchorId,
        {
          claimedOwner: '王大明',
          acquiredAt: new Date('2026-11-01T00:00:00Z'),
          trust: { registeredOwner: '王大明', relatedParties: '某某銀行', registrationStatus: '信託登記中', leaseClause: '受託人得出租' },
        },
        { id: fileId, objectKey: `org/${kit.orgA}/transcripts/${fileId}.pdf`, sha256: 'a'.repeat(64), byteSize: 1, contentType: 'application/pdf', fileName: 't.pdf' },
      );
    });
    await advanceOwnership(kit, trusted, 'verified');
    expect((await gateOf(kit.orgA, trusted)).node).toMatchObject({
      trustRegistered: true,
      trustItemsProvided: ['trust_registered_owner', 'trust_parties', 'trust_registration_status', 'trust_leasing_power_clause'],
    });
  });
});

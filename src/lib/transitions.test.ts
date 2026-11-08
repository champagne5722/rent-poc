import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { commitTransition, createContract, getContract, listContractEvents } from './contracts';
import { withTx } from './pg/database';
import { setupRouteDb, type RouteDb } from './pg/route-test-kit';
import { newUlid } from './pg/ulid';
import type { OrgTx } from './pg/with-tx';
import { applySigningResult, decideTransition } from './transitions';
import type { ContractFields, ContractStatus } from './types';

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(() => kit.reset());

const inA = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: kit.orgA }, fn);

/** 建一份指定狀態的合約，歷程只有「建立」。 */
async function seedContract(status: ContractStatus): Promise<string> {
  return inA(async (tx) => {
    const id = await createContract(tx, { property_id: null, fields: {} as ContractFields });
    if (status !== 'draft') await tx.query('UPDATE org.contracts SET status = $2 WHERE id = $1', [id, status]);
    return id;
  });
}

const statusOf = async (id: string) => (await inA((tx) => getContract(tx, id)))?.status;
const eventTypes = async (id: string) => (await inA((tx) => listContractEvents(tx, id))).map((e) => e.type);

const PARTY_A = { role: 'party_a', name: '林房東', email: 'landlord@example.com' } as const;
const PARTY_B = { role: 'party_b', name: '王租客', email: 'tenant@example.com' } as const;
const PRACTITIONER = { role: 'practitioner', name: '陳管理', email: 'manager@example.com' } as const;

describe('decideTransition：自管租賃合約的轉移意義不變（PRD P0-10 AC7）', () => {
  it('送簽：草稿依第一位簽署人的角色進入簽署中，記送簽事件', () => {
    expect(decideTransition('draft', { type: 'sent', first: PARTY_B })).toEqual({
      status: 'awaiting_tenant',
      event: { type: 'sent', actor: 'landlord', note: '寄送給乙方 tenant@example.com' },
    });
  });

  it('乙方簽完：進入待甲方簽，記簽署人簽署事件，行為者是乙方', () => {
    expect(decideTransition('awaiting_tenant', { type: 'signer_signed', signer: PARTY_B, next: PARTY_A })).toEqual({
      status: 'awaiting_landlord',
      event: { type: 'signer_signed', actor: 'party_b', note: null },
    });
  });

  it('甲方是最後一位：不改合約狀態，也不寫合約歷程', () => {
    expect(
      decideTransition('awaiting_landlord', { type: 'signer_signed', signer: PARTY_A, next: null })
    ).toBeNull();
  });

  it.each(['awaiting_tenant', 'awaiting_landlord', 'awaiting_practitioner'] as const)(
    '%s 全員完成：進入已完成，記簽署完成事件',
    (status) => {
      expect(decideTransition(status, { type: 'completed' })).toEqual({
        status: 'completed',
        event: { type: 'completed', actor: 'system', note: null },
      });
    }
  );

  it('拒簽帶原因：事件附註記下原因，行為者是拒簽的簽署人', () => {
    expect(
      decideTransition('awaiting_tenant', { type: 'declined', signer: PARTY_B, reason: '租金認知有落差' })
    ).toEqual({
      status: 'declined',
      event: { type: 'declined', actor: 'party_b', note: '租金認知有落差' },
    });
    expect(decideTransition('awaiting_landlord', { type: 'declined', signer: PARTY_A })).toEqual({
      status: 'declined',
      event: { type: 'declined', actor: 'party_a', note: null },
    });
  });

  it('拒簽時沒有當前簽署人：行為者是系統', () => {
    expect(decideTransition('awaiting_landlord', { type: 'declined', signer: null })).toMatchObject({
      event: { type: 'declined', actor: 'system' },
    });
  });

  it('撤回：由房東發動', () => {
    expect(decideTransition('awaiting_tenant', { type: 'voided' })).toEqual({
      status: 'voided',
      event: { type: 'voided', actor: 'landlord', note: null },
    });
  });

  it.each(['draft', 'completed', 'declined', 'voided'] as const)('%s 不接受任何簽署結果', (status) => {
    expect(decideTransition(status, { type: 'signer_signed', signer: PARTY_B, next: PARTY_A })).toBeNull();
    expect(decideTransition(status, { type: 'completed' })).toBeNull();
    expect(decideTransition(status, { type: 'declined', signer: PARTY_B })).toBeNull();
    expect(decideTransition(status, { type: 'voided' })).toBeNull();
  });

  it.each(['awaiting_tenant', 'awaiting_landlord', 'completed', 'declined', 'voided'] as const)(
    '%s 不能再送簽',
    (status) => {
      expect(decideTransition(status, { type: 'sent', first: PARTY_B })).toBeNull();
    }
  );
});

describe('decideTransition：合約狀態由簽署角色投影', () => {
  it.each([
    [PARTY_B, 'awaiting_tenant', '寄送給乙方 tenant@example.com'],
    [PARTY_A, 'awaiting_landlord', '寄送給甲方 landlord@example.com'],
    [PRACTITIONER, 'awaiting_practitioner', '寄送給執業人員 manager@example.com'],
  ] as const)('第一位是 $role 時，送簽後進入 %s', (first, status, note) => {
    expect(decideTransition('draft', { type: 'sent', first })).toEqual({
      status,
      event: { type: 'sent', actor: 'landlord', note },
    });
  });

  it.each([
    ['awaiting_tenant', PARTY_B, PRACTITIONER, 'awaiting_practitioner'],
    ['awaiting_practitioner', PRACTITIONER, PARTY_A, 'awaiting_landlord'],
    ['awaiting_landlord', PARTY_A, PARTY_B, 'awaiting_tenant'],
  ] as const)('%s 由目前簽署人簽完後，依下一位的角色進入 %s', (status, signer, next, expected) => {
    expect(decideTransition(status, { type: 'signer_signed', signer, next })).toEqual({
      status: expected,
      event: { type: 'signer_signed', actor: signer.role, note: null },
    });
  });

  it('執業人員拒簽：行為者是執業人員', () => {
    expect(decideTransition('awaiting_practitioner', { type: 'declined', signer: PRACTITIONER })).toMatchObject({
      status: 'declined',
      event: { actor: 'practitioner' },
    });
  });
});

describe('applySigningResult（狀態轉移與歷程事件同交易）', () => {
  it('走完一輪簽署流程後，事件序列與狀態一致', async () => {
    const id = await seedContract('draft');

    await inA((tx) => applySigningResult(tx, id, { type: 'sent', first: PARTY_B }));
    await inA((tx) => applySigningResult(tx, id, { type: 'signer_signed', signer: PARTY_B, next: PARTY_A }));
    // 最後一位簽完不動狀態，等全員完成
    await inA((tx) => applySigningResult(tx, id, { type: 'signer_signed', signer: PARTY_A, next: null }));
    await inA((tx) => applySigningResult(tx, id, { type: 'completed' }));

    expect(await statusOf(id)).toBe('completed');
    expect((await inA((tx) => listContractEvents(tx, id))).map((e) => [e.type, e.actor])).toEqual([
      ['created', 'landlord'],
      ['sent', 'landlord'],
      ['signer_signed', 'party_b'],
      ['completed', 'system'],
    ]);
  });

  it('回傳新狀態；合約的狀態以資料庫為準，不是呼叫端傳的', async () => {
    const id = await seedContract('awaiting_tenant');
    expect(await inA((tx) => applySigningResult(tx, id, { type: 'completed' }))).toBe('completed');
  });

  it('拒簽事件寫入原因附註，合約也留下拒簽原因', async () => {
    const id = await seedContract('awaiting_tenant');
    await inA((tx) => applySigningResult(tx, id, { type: 'declined', signer: PARTY_B, reason: '租金認知有落差' }));

    const events = await inA((tx) => listContractEvents(tx, id));
    expect(events.at(-1)).toMatchObject({ type: 'declined', actor: 'party_b', note: '租金認知有落差' });
    expect((await inA((tx) => getContract(tx, id)))?.declined_reason).toBe('租金認知有落差');
  });

  it('沒有轉移時不改狀態也不寫事件，回傳 null', async () => {
    const id = await seedContract('draft');
    expect(await inA((tx) => applySigningResult(tx, id, { type: 'completed' }))).toBeNull();
    expect(await statusOf(id)).toBe('draft');
    expect(await eventTypes(id)).toEqual(['created']);
  });

  it('合約不存在，或是別的組織的合約，回傳 null 且不寫任何東西', async () => {
    const other = await withTx({ kind: 'org', orgId: kit.orgB }, async (tx) => createContract(tx, { property_id: null, fields: {} as ContractFields }));
    expect(await inA((tx) => applySigningResult(tx, newUlid(), { type: 'voided' }))).toBeNull();
    expect(await inA((tx) => applySigningResult(tx, other, { type: 'voided' }))).toBeNull();
    expect((await withTx({ kind: 'org', orgId: kit.orgB }, (tx) => getContract(tx, other)))?.status).toBe('draft');
  });

  it('事件寫入失敗時，狀態一起回滾', async () => {
    const id = await seedContract('awaiting_tenant');
    await kit.asOwner((db) =>
      db.exec(`CREATE FUNCTION org.fail_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '寫入失敗'; END $$;
               CREATE TRIGGER fail_event BEFORE INSERT ON org.contract_events FOR EACH ROW WHEN (NEW.type = 'completed') EXECUTE FUNCTION org.fail_event();`),
    );

    await expect(inA((tx) => applySigningResult(tx, id, { type: 'completed' }))).rejects.toThrow('寫入失敗');

    expect(await statusOf(id)).toBe('awaiting_tenant');
    expect(await eventTypes(id)).toEqual(['created']);
  });

  it('狀態轉移失敗時，事件也不會留下', async () => {
    const id = await seedContract('awaiting_tenant');
    await kit.asOwner((db) =>
      db.exec(`CREATE FUNCTION org.fail_status() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '更新失敗'; END $$;
               CREATE TRIGGER fail_status BEFORE UPDATE ON org.contracts FOR EACH ROW EXECUTE FUNCTION org.fail_status();`),
    );

    await expect(inA((tx) => applySigningResult(tx, id, { type: 'completed' }))).rejects.toThrow('更新失敗');

    await kit.asOwner((db) => db.exec('DROP TRIGGER fail_status ON org.contracts'));
    expect(await statusOf(id)).toBe('awaiting_tenant');
    expect(await eventTypes(id)).toEqual(['created']);
  });

  it('commitTransition：送簽把狀態與「送簽」事件一起寫入', async () => {
    const id = await seedContract('draft');
    await inA((tx) =>
      commitTransition(tx, id, { status: 'awaiting_tenant', event: { type: 'sent', actor: 'landlord', note: '寄送給乙方 tenant@example.com' } }),
    );
    expect(await statusOf(id)).toBe('awaiting_tenant');
    expect(await eventTypes(id)).toEqual(['created', 'sent']);
  });
});

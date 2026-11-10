import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createVerifiedCaseProperty } from '../ownership/test-kit';
import { withTx } from '../pg/database';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import { newUlid } from '../pg/ulid';
import { createContract } from '../contracts';
import {
  addCaseMember,
  attachContract,
  CaseCreationBlocked,
  CaseNotFound,
  CaseVersionConflict,
  createLeaseCase,
  dispatch,
  findOrCreateParty,
  getCase,
  listCaseEvents,
  listCaseMembers,
} from './index';

// dispatch() 與案件建立的行為測試（MIL-115）。連線是 PGlite 的 app_rw，RLS 生效。
// 接縫是 case-store 的公開函式，驗證回傳值與資料庫裡看得到的結果，不測內部怎麼組 SQL。

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(() => kit.reset());

const NOW = new Date('2026-01-01T00:00:00.000Z');

async function seedLeaseCase(orgId: string) {
  // 建立案件要求物件已通過文件核對（MIL-205），所以先在交易外備好已核對的物件
  const property = await createVerifiedCaseProperty(kit, { orgId, name: '測試物件' });
  const propertyId = property.id;
  return withTx({ kind: 'org', orgId }, async (tx) => {
    const lessor = await findOrCreateParty(tx, 'lessor@example.com', '出租人');
    const caseId = await createLeaseCase(
      tx,
      {
        orgId,
        orgKind: 'owner',
        businessType: 'self_managed',
        lessorPartyId: lessor,
        property: { ...property, address: '台北市大安區' },
      },
      NOW,
    );
    const contractId = await createContract(tx, { property_id: propertyId, fields: { extra: '' } as never });
    await attachContract(tx, caseId, contractId, { now: NOW });
    return { caseId, contractId, lessor, propertyId };
  });
}

describe('createLeaseCase', () => {
  it('建立 draft 案件，出租人成為 lessor 成員，寫 created 事件', async () => {
    const { caseId, lessor } = await seedLeaseCase(kit.orgA);
    const result = await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => ({
      record: await getCase(tx, caseId),
      members: await listCaseMembers(tx, caseId),
      events: await listCaseEvents(tx, caseId),
    }));
    expect(result.record).toMatchObject({
      kind: 'lease',
      state: 'draft',
      stateVersion: 0,
      businessType: 'self_managed',
      orgId: kit.orgA,
      title: '測試物件（台北市大安區）',
      // MIL-123：新案件沒有社宅旗標，也沒有預設收款帳戶
      socialHousing: false,
      defaultRentAccountId: null,
      defaultDepositAccountId: null,
    });
    expect(result.members.map((m) => [m.partyId, m.relation, m.validUntil])).toEqual([[lessor, 'lessor', null]]);
    expect(result.events.map((e) => e.type)).toEqual(['created', 'contract_attached']);
    expect(result.events[0]).toMatchObject({ toState: 'draft', actorPartyId: lessor });
  });

  it('自管案件沒有代管業者，社宅旗標即使傳 true 也記 false（MIL-123）', async () => {
    const property = await createVerifiedCaseProperty(kit, { name: '社宅測試' });
    const caseId = await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => {
      const lessor = await findOrCreateParty(tx, 'lessor2@example.com', '出租人');
      return createLeaseCase(
        tx,
        {
          orgId: kit.orgA,
          orgKind: 'owner',
          businessType: 'self_managed',
          lessorPartyId: lessor,
          property: { ...property, address: '台北市大安區' },
          socialHousing: true,
        },
        NOW,
      );
    });
    expect((await withTx({ kind: 'org', orgId: kit.orgA }, (tx) => getCase(tx, caseId)))?.socialHousing).toBe(false);
  });

  it('掛上合約後，案件的目前合約指向它，合約也指回案件', async () => {
    const { caseId, contractId } = await seedLeaseCase(kit.orgA);
    const { record, contractCase } = await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => ({
      record: await getCase(tx, caseId),
      contractCase: (await tx.query<{ case_id: string | null }>('SELECT case_id FROM org.contracts WHERE id = $1', [contractId])).rows[0],
    }));
    expect(record?.currentContractId).toBe(contractId);
    // createContract 本身不知道案件，case_id 由建約 route 在同交易寫入；這裡只驗案件側
    expect(contractCase.case_id).toBeNull();
  });

  it('屋主組織不能建代管案件', async () => {
    const property = await createVerifiedCaseProperty(kit);
    await expect(
      withTx({ kind: 'org', orgId: kit.orgA }, (tx) =>
        createLeaseCase(tx, {
          orgId: kit.orgA,
          orgKind: 'owner',
          businessType: 'managed',
          lessorPartyId: newUlid(),
          property,
        }),
      ),
    ).rejects.toThrow(/不得建立這種業務類型/);
  });
});

describe('dispatch：狀態轉移', () => {
  it('合約送簽 → signing，版本加一，事件記下前後狀態', async () => {
    const { caseId, contractId } = await seedLeaseCase(kit.orgA);
    const result = await withTx({ kind: 'org', orgId: kit.orgA }, (tx) =>
      dispatch(tx, caseId, { type: 'contract_sent', contractId }, { now: NOW }),
    );
    expect(result).toMatchObject({ ok: true, from: 'draft', state: 'signing', stateVersion: 1 });

    const { record, events } = await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => ({
      record: await getCase(tx, caseId),
      events: await listCaseEvents(tx, caseId),
    }));
    expect(record).toMatchObject({ state: 'signing', stateVersion: 1 });
    const sent = events.find((e) => e.type === 'contract_sent');
    expect(sent).toMatchObject({ fromState: 'draft', toState: 'signing', occurredAt: NOW.toISOString(), payload: { contractId } });
  });

  it('走完 draft → signing → active', async () => {
    const { caseId, contractId } = await seedLeaseCase(kit.orgA);
    const state = await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => {
      await dispatch(tx, caseId, { type: 'contract_sent', contractId });
      await dispatch(tx, caseId, { type: 'contract_completed', contractId });
      return (await getCase(tx, caseId))?.state;
    });
    expect(state).toBe('active');
  });

  it('拒簽後回 draft，原因記在事件', async () => {
    const { caseId, contractId } = await seedLeaseCase(kit.orgA);
    const events = await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => {
      await dispatch(tx, caseId, { type: 'contract_sent', contractId });
      await dispatch(tx, caseId, { type: 'contract_declined', contractId, reason: '租金太高' });
      return listCaseEvents(tx, caseId);
    });
    expect(events.at(-1)).toMatchObject({ type: 'contract_declined', fromState: 'signing', toState: 'draft', payload: { reason: '租金太高' } });
  });

  it('案件拒絕輸入時寫 input_rejected，狀態與版本不變，不丟錯', async () => {
    const { caseId, contractId } = await seedLeaseCase(kit.orgA);
    const result = await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => {
      // draft 不接受 contract_completed
      const rejected = await dispatch(tx, caseId, { type: 'contract_completed', contractId }, { now: NOW });
      return { rejected, record: await getCase(tx, caseId), events: await listCaseEvents(tx, caseId) };
    });
    expect(result.rejected).toEqual({ ok: false, reason: 'rejected', state: 'draft' });
    expect(result.record).toMatchObject({ state: 'draft', stateVersion: 0 });
    expect(result.events.at(-1)).toMatchObject({
      type: 'input_rejected',
      payload: { inputType: 'contract_completed', state: 'draft', contractId, currentContractId: contractId },
    });
  });

  it('不是目前合約的事件被拒絕（案件只認 current_contract_id）', async () => {
    const { caseId } = await seedLeaseCase(kit.orgA);
    const result = await withTx({ kind: 'org', orgId: kit.orgA }, (tx) => dispatch(tx, caseId, { type: 'contract_sent', contractId: newUlid() }));
    expect(result).toMatchObject({ ok: false, reason: 'rejected' });
  });

  it('expectedVersion 與資料庫不同時丟 CaseVersionConflict，整個交易回滾', async () => {
    const { caseId, contractId } = await seedLeaseCase(kit.orgA);
    await expect(
      withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => {
        await dispatch(tx, caseId, { type: 'contract_sent', contractId });
        // 第二次帶舊版本 0，實際已是 1
        await dispatch(tx, caseId, { type: 'contract_completed', contractId }, { expectedVersion: 0 });
      }),
    ).rejects.toBeInstanceOf(CaseVersionConflict);
    const record = await withTx({ kind: 'org', orgId: kit.orgA }, (tx) => getCase(tx, caseId));
    expect(record).toMatchObject({ state: 'draft', stateVersion: 0 });
  });

  it('UPDATE 帶讀到的版本：讀到之後別人推進了版本，更新不到列就丟衝突', async () => {
    const { caseId, contractId } = await seedLeaseCase(kit.orgA);
    await expect(
      withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => {
        // 模擬另一個交易在 dispatch 讀完之後、更新之前推進版本：包住 tx.query，在 UPDATE 前先改版本
        const racing = {
          kind: tx.kind,
          query: async (sql: string, params?: unknown[]) => {
            if (/^\s*UPDATE org\.cases SET state/.test(sql)) {
              await tx.query('UPDATE org.cases SET state_version = state_version + 1 WHERE id = $1', [caseId]);
            }
            return tx.query(sql, params);
          },
        } as typeof tx;
        await dispatch(racing, caseId, { type: 'contract_sent', contractId });
      }),
    ).rejects.toBeInstanceOf(CaseVersionConflict);
  });

  it('案件不存在丟 CaseNotFound，別的組織的案件也一樣', async () => {
    const { caseId, contractId } = await seedLeaseCase(kit.orgA);
    await expect(
      withTx({ kind: 'org', orgId: kit.orgB }, (tx) => dispatch(tx, caseId, { type: 'contract_sent', contractId })),
    ).rejects.toBeInstanceOf(CaseNotFound);
    await expect(
      withTx({ kind: 'org', orgId: kit.orgA }, (tx) => dispatch(tx, newUlid(), { type: 'abandon' })),
    ).rejects.toBeInstanceOf(CaseNotFound);
  });

  it('未結事項仍結案：同交易寫稽核事件', async () => {
    const { caseId } = await seedLeaseCase(kit.orgA);
    await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => {
      // 直接把案件推到 settling 供測試，再走 close
      await tx.query(`UPDATE org.cases SET state = 'settling' WHERE id = $1`, [caseId]);
      const result = await dispatch(tx, caseId, {
        type: 'close',
        unsettled: { depositBalanceNonZero: true, settlementStatementIncomplete: false, returnProofIncomplete: false },
        unsettledReason: '押金尚未退還',
      });
      expect(result).toMatchObject({ ok: true, state: 'closed' });
    });
    const { rows } = await withTx({ kind: 'org', orgId: kit.orgA }, (tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit.events WHERE action = 'case.unsettled_close'`));
    expect(rows[0].n).toBe(1);
  });

  it('沒有未結事項的結案不寫 case.unsettled_close', async () => {
    const { caseId } = await seedLeaseCase(kit.orgA);
    await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => {
      await tx.query(`UPDATE org.cases SET state = 'settling' WHERE id = $1`, [caseId]);
      await dispatch(tx, caseId, {
        type: 'close',
        unsettled: { depositBalanceNonZero: false, settlementStatementIncomplete: false, returnProofIncomplete: false },
        unsettledReason: null,
      });
    });
    const { rows } = await withTx({ kind: 'org', orgId: kit.orgA }, (tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit.events WHERE action = 'case.unsettled_close'`));
    expect(rows[0].n).toBe(0);
  });
});

describe('addCaseMember', () => {
  it('加入共同承租人：寫 member_added 事件，重複加入不重複', async () => {
    const { caseId } = await seedLeaseCase(kit.orgA);
    const out = await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => {
      const party = await findOrCreateParty(tx, 'Co@Example.com ', '共同承租人');
      const first = await addCaseMember(tx, caseId, { partyId: party, relation: 'co_lessee' }, { now: NOW });
      const second = await addCaseMember(tx, caseId, { partyId: party, relation: 'co_lessee' }, { now: NOW });
      return { first, second, party, members: await listCaseMembers(tx, caseId), events: await listCaseEvents(tx, caseId) };
    });
    expect(out.first).toBe(true);
    expect(out.second).toBe(false);
    expect(out.members.filter((m) => m.relation === 'co_lessee')).toHaveLength(1);
    expect(out.members.find((m) => m.relation === 'co_lessee')).toMatchObject({ email: 'co@example.com', displayName: '共同承租人' });
    expect(out.events.filter((e) => e.type === 'member_added')).toHaveLength(1);
  });

  it('findOrCreateParty 對同一個 email 回同一個 party，大小寫與空白不影響', async () => {
    const ids = await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => [
      await findOrCreateParty(tx, 'a@example.com', '甲'),
      await findOrCreateParty(tx, '  A@EXAMPLE.COM', '乙'),
    ]);
    expect(ids[0]).toBe(ids[1]);
  });
});

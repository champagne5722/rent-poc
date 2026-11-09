import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Forbidden } from '../authorize';
import type { CaseMemberRelation, CaseState } from '../cases';
import { withTx } from '../pg/database';
import { setupRouteDb, TEST_USER_ID, type RouteDb } from '../pg/route-test-kit';
import { newUlid } from '../pg/ulid';
import type { OrgRole, RequestContext } from '../request-context';
import { findOrCreateParty, getCase, insertCase, insertCaseEvent, insertCaseMember, listCaseEvents, withCaseMemberTx, type CaseMemberTx } from './index';
import { buildCaseEvent } from '../cases';

// withCaseMemberTx 的行為測試（ADR-0016 決議 16，MIL-115）。連線是 PGlite 的 app_rw，RLS 生效。
// 接縫是 withCaseMemberTx 的公開介面：成員身分進來，看寫入有沒有落在案件所在的組織、被拒時有沒有留下任何東西。

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(() => kit.reset());

const NOW = new Date('2026-01-01T00:00:00.000Z');

interface World {
  caseId: string;
  otherCaseId: string;
  lessee: string;
  lessor: string;
  outsider: string;
  expired: string;
}

async function seedWorld(state: CaseState = 'active'): Promise<World> {
  // 案件在 orgA（主辦組織）。成員是別人：承租人沒有組織，出租人屬於 orgB
  return withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => {
    const [lessee, lessor, outsider, expired] = await Promise.all(
      ['lessee', 'lessor', 'outsider', 'expired'].map((n) => findOrCreateParty(tx, `${n}@example.com`, n)),
    );
    const make = async (caseId: string) => {
      await insertCase(
        tx,
        { kind: 'lease', id: caseId, orgId: kit.orgA, state: 'draft', stateVersion: 0, currentContractId: null, businessType: 'self_managed', rentalUnitId: '', linkedMandateCaseId: null, predecessorCaseId: null, handoverId: null },
        { title: '案件', propertyId: null, rentalUnitId: null },
        NOW,
      );
      await tx.query(`UPDATE org.cases SET state = $2 WHERE id = $1`, [caseId, state]);
    };
    const caseId = newUlid();
    const otherCaseId = newUlid();
    await make(caseId);
    await make(otherCaseId);
    await insertCaseMember(tx, caseId, { partyId: lessee, relation: 'lessee' }, NOW);
    await insertCaseMember(tx, caseId, { partyId: lessor, relation: 'lessor' }, NOW);
    await insertCaseMember(tx, otherCaseId, { partyId: outsider, relation: 'lessee' }, NOW);
    await tx.query(
      `INSERT INTO org.case_members (id, org_id, case_id, party_id, relation, valid_period)
       VALUES ($1, $2, $3, $4, 'lessee', tstzrange(now() - interval '2 days', now() - interval '1 day', '[)'))`,
      [newUlid(), kit.orgA, caseId, expired],
    );
    return { caseId, otherCaseId, lessee, lessor, outsider, expired };
  });
}

const partyRc = (partyId: string): Extract<RequestContext, { kind: 'party' }> => ({ kind: 'party', userId: TEST_USER_ID, partyId, requestId: 't' });
const orgRc = (partyId: string, role: OrgRole = 'admin'): Extract<RequestContext, { kind: 'org' }> => ({
  kind: 'org',
  orgId: kit.orgB,
  orgKind: 'owner',
  userId: TEST_USER_ID,
  partyId,
  role,
  requestId: 't',
});

/** 固定的 repository 方法：收 CaseMemberTx，用 tx.caseId 過濾，不接受別的案件。 */
const reportRepair = (tx: CaseMemberTx) =>
  insertCaseEvent(tx, tx.caseId, { event: buildCaseEvent('member_added', NOW, { note: 'repair.report' }), actorPartyId: null });

const forbiddenReason = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(Forbidden);
    return (error as Forbidden).reason;
  }
  throw new Error('預期丟 Forbidden，但通過了');
};

const eventsOf = (caseId: string) => withTx({ kind: 'org', orgId: kit.orgA }, (tx) => listCaseEvents(tx, caseId));

describe('withCaseMemberTx：成員寫入別的組織的資料', () => {
  it('承租人（沒有組織）報修：寫入落在案件所在的組織，grant 與關係帶進 callback', async () => {
    const w = await seedWorld();
    const seen = await withCaseMemberTx(partyRc(w.lessee), { caseId: w.caseId, action: 'repair.report' }, async (tx) => {
      await reportRepair(tx);
      return { caseId: tx.caseId, orgId: tx.orgId, grant: tx.grant, relations: [...tx.relations] };
    });
    expect(seen).toEqual({ caseId: w.caseId, orgId: kit.orgA, grant: { via: 'case_relation', onBehalf: false }, relations: ['lessee'] });
    expect((await eventsOf(w.caseId)).filter((e) => e.payload.note === 'repair.report')).toHaveLength(1);
  });

  it('屋主以自己的組織身分（org 脈絡）確認點交：orgB 的成員寫入 orgA 的案件', async () => {
    const w = await seedWorld();
    await withCaseMemberTx(orgRc(w.lessor), { caseId: w.caseId, action: 'inspection.confirm' }, (tx) => reportRepair(tx));
    expect(await eventsOf(w.caseId)).toHaveLength(1);
  });

  it('不是成員：丟 Forbidden（not_a_member），什麼都沒寫', async () => {
    const w = await seedWorld();
    const reason = await forbiddenReason(
      withCaseMemberTx(partyRc(w.outsider), { caseId: w.caseId, action: 'repair.report' }, (tx) => reportRepair(tx)),
    );
    expect(reason).toBe('not_a_member');
    expect(await eventsOf(w.caseId)).toHaveLength(0);
  });

  it('成員資格過期：丟 Forbidden', async () => {
    const w = await seedWorld();
    const reason = await forbiddenReason(
      withCaseMemberTx(partyRc(w.expired), { caseId: w.caseId, action: 'repair.report' }, (tx) => reportRepair(tx)),
    );
    // self_read 看得到過期的列，所以步驟 1 通過；案件本身已經讀不到（member_read 只放行有效關係）。對外是同一個拒絕
    expect(reason).toBe('object_not_found');
    expect(await eventsOf(w.caseId)).toHaveLength(0);
  });

  it('案件不存在與不是成員，是同一個 Forbidden 原因', async () => {
    const w = await seedWorld();
    const missing = await forbiddenReason(
      withCaseMemberTx(partyRc(w.lessee), { caseId: newUlid(), action: 'repair.report' }, (tx) => reportRepair(tx)),
    );
    expect(missing).toBe('not_a_member');
  });

  it('只讀得到自己是成員的案件：拿別的案件 ID 被拒', async () => {
    const w = await seedWorld();
    const reason = await forbiddenReason(
      withCaseMemberTx(partyRc(w.lessee), { caseId: w.otherCaseId, action: 'repair.report' }, (tx) => reportRepair(tx)),
    );
    expect(reason).toBe('not_a_member');
  });

  it('動作不授予這個關係：authorize() 拒絕（not_granted），交易回滾', async () => {
    const w = await seedWorld();
    const reason = await forbiddenReason(
      withCaseMemberTx(partyRc(w.lessee), { caseId: w.caseId, action: 'ledger.record_payment' }, (tx) => reportRepair(tx)),
    );
    expect(reason).toBe('not_granted');
    expect(await eventsOf(w.caseId)).toHaveLength(0);
  });

  it('案件狀態不允許：draft 的案件承租人不能報修', async () => {
    const w = await seedWorld('draft');
    const reason = await forbiddenReason(
      withCaseMemberTx(partyRc(w.lessee), { caseId: w.caseId, action: 'repair.report' }, (tx) => reportRepair(tx)),
    );
    expect(reason).toBe('state_not_allowed');
  });

  it('結案後唯讀：寫入被拒（case_closed_read_only），讀取仍可', async () => {
    const w = await seedWorld('closed');
    const reason = await forbiddenReason(
      withCaseMemberTx(partyRc(w.lessee), { caseId: w.caseId, action: 'repair.report' }, (tx) => reportRepair(tx)),
    );
    expect(reason).toBe('case_closed_read_only');
    const state = await withCaseMemberTx(partyRc(w.lessee), { caseId: w.caseId, action: 'case.read_summary' }, async (tx) => (await getCase(tx, tx.caseId))?.state);
    expect(state).toBe('closed');
  });

  it('組織角色是 viewer 的屋主，寫入被拒（viewer_read_only）', async () => {
    const w = await seedWorld();
    const reason = await forbiddenReason(
      withCaseMemberTx(orgRc(w.lessor, 'viewer'), { caseId: w.caseId, action: 'inspection.confirm' }, (tx) => reportRepair(tx)),
    );
    expect(reason).toBe('viewer_read_only');
  });

  it('callback 丟錯：整個交易回滾', async () => {
    const w = await seedWorld();
    await expect(
      withCaseMemberTx(partyRc(w.lessee), { caseId: w.caseId, action: 'repair.report' }, async (tx) => {
        await reportRepair(tx);
        throw new Error('中途失敗');
      }),
    ).rejects.toThrow('中途失敗');
    expect(await eventsOf(w.caseId)).toHaveLength(0);
  });

  it('已知風險（ADR-0016 Consequences）：第 3 步之後 tx 看得到整個組織的案件，所以 repository 方法必須用 tx.caseId 過濾', async () => {
    const w = await seedWorld();
    const visible = await withCaseMemberTx(partyRc(w.lessee), { caseId: w.caseId, action: 'case.read_summary' }, async (tx) =>
      (await tx.query<{ id: string }>('SELECT id FROM org.cases')).rows.map((r) => r.id).sort(),
    );
    expect(visible).toEqual([w.caseId, w.otherCaseId].sort());
    // 固定的 repository 方法只碰 tx.caseId 的案件
    await withCaseMemberTx(partyRc(w.lessee), { caseId: w.caseId, action: 'repair.report' }, (tx) => reportRepair(tx));
    expect(await eventsOf(w.otherCaseId)).toHaveLength(0);
  });

  it('交易結束後 org 脈絡消失：同一條連線的下一個交易看不到組織資料', async () => {
    const w = await seedWorld();
    await withCaseMemberTx(partyRc(w.lessee), { caseId: w.caseId, action: 'case.read_summary' }, async () => undefined);
    const rows = await withTx({ kind: 'party', partyId: w.outsider }, (tx) => tx.query<{ id: string }>('SELECT id FROM org.cases'));
    expect(rows.rows.map((r) => r.id)).toEqual([w.otherCaseId]);
  });
});

describe('成員關係與動作：全部關係都走同一個入口', () => {
  const RELATIONS_THAT_READ: CaseMemberRelation[] = ['lessor', 'lessee', 'co_lessee', 'practitioner', 'broker'];
  it.each(RELATIONS_THAT_READ)('%s 能讀 self_managed 案件的租期與狀態', async (relation) => {
    const w = await seedWorld();
    const party = await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => {
      const id = await findOrCreateParty(tx, `${relation}@relation.example.com`, relation);
      await insertCaseMember(tx, w.caseId, { partyId: id, relation }, NOW);
      return id;
    });
    const state = await withCaseMemberTx(partyRc(party), { caseId: w.caseId, action: 'case.read_summary' }, async (tx) => (await getCase(tx, tx.caseId))?.state);
    expect(state).toBe('active');
  });
});

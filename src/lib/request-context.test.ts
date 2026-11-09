import { describe, expect, it } from 'vitest';
import { toDbContext, Unauthenticated, type RequestContext } from './request-context';
import { buildBeginSql } from './pg/with-tx';

const SEED_DEFAULT_ORG = '00000000000000000000000002';

describe('Unauthenticated', () => {
  it('預設原因是 no_session，可帶原因；訊息不洩漏細節', () => {
    expect(new Unauthenticated().reason).toBe('no_session');
    const e = new Unauthenticated(undefined, 'membership_lost');
    expect(e.reason).toBe('membership_lost');
    expect(e.message).toBe('尚未登入或沒有存取權');
    expect(e).toBeInstanceOf(Error);
  });
});

describe('toDbContext', () => {
  const org: RequestContext = {
    kind: 'org',
    orgId: SEED_DEFAULT_ORG,
    orgKind: 'owner',
    userId: '00000000000000000000000003',
    partyId: '00000000000000000000000004',
    role: 'admin',
    requestId: 'r',
  };

  it('org 轉成帶 partyId 的 org 脈絡，可直接開交易', () => {
    const ctx = toDbContext(org as Extract<RequestContext, { kind: 'org' }>);
    expect(ctx).toEqual({ kind: 'org', orgId: SEED_DEFAULT_ORG, partyId: '00000000000000000000000004' });
    expect(buildBeginSql(ctx)).toContain(SEED_DEFAULT_ORG);
  });

  it('party 只帶 partyId', () => {
    const rc = { kind: 'party', userId: '00000000000000000000000003', partyId: '00000000000000000000000004', requestId: 'r' } as const;
    expect(toDbContext(rc)).toEqual({ kind: 'party', partyId: rc.partyId });
  });

  it('operator 必須另外帶目標組織與工單號', () => {
    const rc = { kind: 'operator', userId: '00000000000000000000000003', partyId: '00000000000000000000000004', requestId: 'r' } as const;
    expect(toDbContext(rc, { orgId: SEED_DEFAULT_ORG, ticketId: 'CASE-7' })).toEqual({
      kind: 'operator',
      operatorId: rc.userId,
      orgId: SEED_DEFAULT_ORG,
      ticketId: 'CASE-7',
    });
    // 型別層級 operator 沒帶目標會 tsc 報錯；寬型別的呼叫在執行期也擋下
    expect(() => toDbContext(rc as RequestContext)).toThrow(/工單號/);
  });

  it('operator 的工單號為空時，轉出的脈絡會被 withTx 拒絕', () => {
    const rc = { kind: 'operator', userId: '00000000000000000000000003', partyId: '00000000000000000000000004', requestId: 'r' } as const;
    const ctx = toDbContext(rc, { orgId: SEED_DEFAULT_ORG, ticketId: '' });
    expect(() => buildBeginSql(ctx)).toThrow(/工單號/);
  });
});

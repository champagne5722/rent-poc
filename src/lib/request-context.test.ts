import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORG_ENV,
  resolveTransitionalContext,
  toDbContext,
  Unauthenticated,
  type RequestContext,
} from './request-context';
import { buildBeginSql } from './pg/with-tx';

const SEED_DEFAULT_ORG = '00000000000000000000000002';

describe('過渡期的 requestContext', () => {
  it('回傳環境變數指定的預設組織，形狀照 ADR-0022 決議 7', () => {
    const rc = resolveTransitionalContext({ [DEFAULT_ORG_ENV]: SEED_DEFAULT_ORG }, 'req-1');
    expect(rc).toMatchObject({ kind: 'org', orgId: SEED_DEFAULT_ORG, orgKind: 'owner', role: 'admin', requestId: 'req-1' });
    if (rc.kind !== 'org') throw new Error('應為 org');
    expect(rc.userId).toBeTruthy();
    expect(rc.partyId).toBeTruthy();
  });

  it.each([
    ['沒有設定', {}],
    ['空字串', { [DEFAULT_ORG_ENV]: '' }],
    ['只有空白', { [DEFAULT_ORG_ENV]: '  ' }],
    ['不是 ULID', { [DEFAULT_ORG_ENV]: 'default-org' }],
  ])('%s：不開放存取，丟 Unauthenticated', (_name, env) => {
    expect(() => resolveTransitionalContext(env, 'req-1')).toThrow(Unauthenticated);
  });
});

describe('toDbContext', () => {
  const org = resolveTransitionalContext({ [DEFAULT_ORG_ENV]: SEED_DEFAULT_ORG }, 'r');

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

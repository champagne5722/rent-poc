import { describe, expect, it } from 'vitest';
import { ownerSessionFromContext } from './owner-session';
import type { RequestContext } from './request-context';

const ORG = '01HZZZZZZZZZZZZZZZZZZZZZZA';
const PARTY = '01HZZZZZZZZZZZZZZZZZZZZZZB';
const USER = '01HZZZZZZZZZZZZZZZZZZZZZZC';

const org = (orgKind: 'owner' | 'practice' | 'platform'): RequestContext => ({
  kind: 'org',
  orgId: ORG,
  orgKind,
  userId: USER,
  partyId: PARTY,
  role: 'admin',
  requestId: 'r',
});

describe('ownerSessionFromContext（MIL-94 的回傳形狀）', () => {
  it('屋主組織的 org 脈絡：回傳 partyId、ownerOrgId、displayName 三個欄位', () => {
    const session = ownerSessionFromContext(org('owner'), '王美玲');
    expect(session).toEqual({ partyId: PARTY, ownerOrgId: ORG, displayName: '王美玲' });
    expect(Object.keys(session!).sort()).toEqual(['displayName', 'ownerOrgId', 'partyId']);
  });

  it.each([
    ['執業主體組織', org('practice')],
    ['平台組織', org('platform')],
    ['承租人', { kind: 'party', userId: USER, partyId: PARTY, requestId: 'r' } as RequestContext],
    ['平台營運者', { kind: 'operator', userId: USER, partyId: PARTY, requestId: 'r' } as RequestContext],
  ])('%s 沒有屋主身分', (_name, rc) => {
    expect(ownerSessionFromContext(rc, '王美玲')).toBeNull();
  });
});

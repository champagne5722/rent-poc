import { describe, expect, it } from 'vitest';
import { OWNER_SESSION_ENV, SEED_OWNERS, resolveOwnerSession } from './owner-session';

const [first, second] = SEED_OWNERS;

describe('resolveOwnerSession（屋主身分的假資料版本）', () => {
  it('沒有設定環境變數時，用第一位 seed 屋主', () => {
    expect(resolveOwnerSession({})).toEqual(first);
    expect(resolveOwnerSession({ [OWNER_SESSION_ENV]: '' })).toEqual(first);
  });

  it('環境變數指定 seed 屋主的 party ID 時，回傳該屋主', () => {
    expect(resolveOwnerSession({ [OWNER_SESSION_ENV]: second.partyId })).toEqual(second);
  });

  it('前後空白不影響比對', () => {
    expect(resolveOwnerSession({ [OWNER_SESSION_ENV]: ` ${second.partyId} ` })).toEqual(second);
  });

  it('設成 none 時沒有屋主身分', () => {
    expect(resolveOwnerSession({ [OWNER_SESSION_ENV]: 'none' })).toBeNull();
  });

  it('指定的 party ID 不在 seed 裡時沒有屋主身分', () => {
    expect(resolveOwnerSession({ [OWNER_SESSION_ENV]: 'party-unknown' })).toBeNull();
  });

  it('屋主身分只有 party ID、屋主組織 ID、顯示名稱三個欄位', () => {
    expect(Object.keys(resolveOwnerSession({})!).sort()).toEqual(
      ['displayName', 'ownerOrgId', 'partyId'],
    );
  });
});

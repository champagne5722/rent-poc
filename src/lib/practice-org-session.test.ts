import { describe, expect, it } from 'vitest';
import { PRACTICE_ORG_SESSION_ENV, SEED_PRACTICE_ORGS, resolvePracticeOrgSession } from './practice-org-session';

const [first, second] = SEED_PRACTICE_ORGS;

describe('resolvePracticeOrgSession（後台組織身分的假資料版本）', () => {
  it('沒有設定環境變數時，用第一個 seed 組織', () => {
    expect(resolvePracticeOrgSession({})).toEqual(first);
    expect(resolvePracticeOrgSession({ [PRACTICE_ORG_SESSION_ENV]: '  ' })).toEqual(first);
  });

  it('環境變數指定 seed 組織的 ID 時，回傳該組織', () => {
    expect(resolvePracticeOrgSession({ [PRACTICE_ORG_SESSION_ENV]: ` ${second.orgId} ` })).toEqual(second);
  });

  it('設成 none 或不在 seed 裡時沒有組織身分', () => {
    expect(resolvePracticeOrgSession({ [PRACTICE_ORG_SESSION_ENV]: 'none' })).toBeNull();
    expect(resolvePracticeOrgSession({ [PRACTICE_ORG_SESSION_ENV]: 'org-unknown' })).toBeNull();
  });
});

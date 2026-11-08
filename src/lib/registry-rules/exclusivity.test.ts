import { describe, expect, it } from 'vitest';
import {
  BLOCKED_MESSAGE,
  CERTIFICATE_BADGE_TEXT,
  CERTIFICATE_VALIDITY_YEARS,
  FORBIDDEN_BADGE_WORDS,
  certificateBadge,
  checkValidUntilConsistency,
  containsForbiddenBadgeWord,
  decideEmploymentCreation,
  decideEmploymentVerification,
  decideRecheckResult,
  prefillValidUntil,
  type OtherEmployment,
} from './exclusivity';
import type { CertificateKind } from '../labels';
import type { CredentialState } from './credential-transition';

const TODAY = '2026-11-08';
const AT = '2026-11-08T02:00:00.000Z';

function other(state: CredentialState, overrides: Partial<OtherEmployment> = {}): OtherEmployment {
  return { entityId: 'entity-other', state, periodStart: '2025-01-01', periodEnd: null, ...overrides };
}

const BASE = { certificateNumber: '台內地登字第 123456 號', entityId: 'entity-mine', today: TODAY, at: AT };

describe('判定點 1：建立任職 decideEmploymentCreation', () => {
  type Row = [string, CertificateKind, OtherEmployment[], { outcome: 'blocked' | 'created'; consentRequired?: boolean }];
  const rows: Row[] = [
    ['管理人員，別家沒有任職', 'rental_housing_manager', [], { outcome: 'created', consentRequired: false }],
    ['管理人員，別家只有待驗證（允許並存）', 'rental_housing_manager', [other('pending')], { outcome: 'created', consentRequired: false }],
    ['管理人員，別家任職已失效', 'rental_housing_manager', [other('lapsed')], { outcome: 'created', consentRequired: false }],
    ['管理人員，別家已驗證在職（阻擋）', 'rental_housing_manager', [other('verified')], { outcome: 'blocked' }],
    ['管理人員，別家已驗證且有待驗證', 'rental_housing_manager', [other('pending'), other('verified')], { outcome: 'blocked' }],
    ['管理人員，別家已驗證但任職期間已結束', 'rental_housing_manager', [other('verified', { periodEnd: '2026-11-07' })], { outcome: 'created', consentRequired: false }],
    ['管理人員，別家已驗證，任職期間最後一天是今天', 'rental_housing_manager', [other('verified', { periodEnd: TODAY })], { outcome: 'blocked' }],
    ['管理人員，別家已驗證但任職尚未開始', 'rental_housing_manager', [other('verified', { periodStart: '2026-11-09' })], { outcome: 'created', consentRequired: false }],
    ['管理人員，已驗證的任職是自己這家', 'rental_housing_manager', [other('verified', { entityId: 'entity-mine' })], { outcome: 'created', consentRequired: false }],
    ['經紀人員，別家沒有任職', 'real_estate_broker', [], { outcome: 'created', consentRequired: false }],
    ['經紀人員，別家只有待驗證', 'real_estate_broker', [other('pending')], { outcome: 'created', consentRequired: false }],
    ['經紀人員，別家已驗證在職（要求同意書）', 'real_estate_broker', [other('verified')], { outcome: 'created', consentRequired: true }],
    ['營業員，別家已驗證在職（要求同意書）', 'real_estate_sales_agent', [other('verified')], { outcome: 'created', consentRequired: true }],
  ];

  it.each(rows)('%s', (_name, certificateKind, otherEmployments, expected) => {
    const result = decideEmploymentCreation({ ...BASE, certificateKind, otherEmployments });
    expect(result.outcome).toBe(expected.outcome);
    if (result.outcome === 'created') {
      expect(result.initialState).toBe('pending');
      expect(result.consentRequired).toBe(expected.consentRequired);
    }
  });

  it('阻擋訊息固定，稽核寫證號、時間、原因，兩者都不含別家', () => {
    const result = decideEmploymentCreation({
      ...BASE,
      certificateKind: 'rental_housing_manager',
      otherEmployments: [other('verified', { entityId: 'secret-entity-id' })],
    });
    expect(result).toEqual({
      outcome: 'blocked',
      message: '此證號已有在職紀錄',
      audit: {
        event: 'employment_blocked',
        reason: 'exclusive_employment_elsewhere',
        certificateNumber: BASE.certificateNumber,
        at: AT,
      },
    });
    expect(BLOCKED_MESSAGE).toBe('此證號已有在職紀錄');
    expect(JSON.stringify(result)).not.toContain('secret-entity-id');
  });

  it('經紀人員掛第二家時提示並寫稽核', () => {
    const result = decideEmploymentCreation({
      ...BASE,
      certificateKind: 'real_estate_broker',
      otherEmployments: [other('verified')],
    });
    expect(result).toEqual({
      outcome: 'created',
      initialState: 'pending',
      consentRequired: true,
      notice: '此證號已有其他在職紀錄，請上傳所屬業者的同意書',
      audit: {
        event: 'employment_consent_required',
        reason: 'second_employment_needs_consent',
        certificateNumber: BASE.certificateNumber,
        at: AT,
      },
    });
  });

  it('沒有阻擋也沒有提示時，不產生稽核', () => {
    const result = decideEmploymentCreation({
      ...BASE,
      certificateKind: 'rental_housing_manager',
      otherEmployments: [other('pending')],
    });
    expect(result).toMatchObject({ outcome: 'created', notice: null, audit: null });
  });
});

describe('判定點 2：核對相符 decideEmploymentVerification', () => {
  const verify = (
    certificateKind: CertificateKind,
    otherEmployments: OtherEmployment[],
    consentVerified = false,
  ) => decideEmploymentVerification({ ...BASE, certificateKind, otherEmployments, consentVerified });

  it('管理人員，別家已驗證在職時違反排除約束', () => {
    const result = verify('rental_housing_manager', [other('verified')]);
    expect(result.violatesExclusivity).toBe(true);
    expect(result.audit).toMatchObject({ event: 'verification_blocked', reason: 'exclusive_employment_elsewhere' });
    expect(JSON.stringify(result)).not.toContain('entity-other');
  });

  it('管理人員，別家只有待驗證時不違反（由營運者判定哪家相符）', () => {
    expect(verify('rental_housing_manager', [other('pending')]).violatesExclusivity).toBe(false);
  });

  it('管理人員，別家沒有在職時不違反', () => {
    expect(verify('rental_housing_manager', []).violatesExclusivity).toBe(false);
    expect(verify('rental_housing_manager', [other('lapsed')]).violatesExclusivity).toBe(false);
  });

  it.each(['real_estate_broker', 'real_estate_sales_agent'] as const)('%s 別家已驗證時不擋', (kind) => {
    expect(verify(kind, [other('verified')], true).violatesExclusivity).toBe(false);
  });

  it('經紀人員，別家已驗證且同意書已核對：標示經所屬業者同意', () => {
    expect(verify('real_estate_broker', [other('verified')], true)).toMatchObject({
      violatesExclusivity: false,
      consentedByEntity: true,
      warnings: [],
    });
  });

  it('經紀人員，別家已驗證但同意書未核對：回警示 consent_missing，不擋', () => {
    expect(verify('real_estate_broker', [other('verified')], false)).toMatchObject({
      violatesExclusivity: false,
      consentedByEntity: false,
      warnings: ['consent_missing'],
    });
  });

  it('經紀人員，別家沒有在職：不需同意書，不標示、不警示', () => {
    expect(verify('real_estate_broker', [], true)).toMatchObject({
      consentedByEntity: false,
      warnings: [],
    });
  });
});

describe('判定點 4：定期重驗 decideRecheckResult', () => {
  it.each([
    ['verified', 'match', null],
    ['verified', 'mismatch', 'lapsed'],
    ['verified', 'not_found', 'lapsed'],
    ['verified', 'revoked', 'lapsed'],
    ['pending', 'mismatch', null],
    ['pending', 'match', null],
    ['lapsed', 'mismatch', null],
  ] as const)('%s + %s -> %s', (state, result, expectedTo) => {
    const transition = decideRecheckResult({ layer: 'employment', state, result });
    expect(transition?.to ?? null).toBe(expectedTo);
    if (transition) expect(transition.event).toBe('revoked');
  });
});

describe('valid_until 預填與提示', () => {
  it('效期固定 4 年', () => {
    expect(CERTIFICATE_VALIDITY_YEARS).toBe(4);
  });

  it.each([
    ['2026-11-08', '2030-11-08'],
    ['2024-02-29', '2028-02-29'],
    ['2023-01-31', '2027-01-31'],
  ])('發證日 %s 預填 %s', (issuedOn, expected) => {
    expect(prefillValidUntil(issuedOn)).toBe(expected);
  });

  it('發證日不是有效日期時拋 RangeError', () => {
    expect(() => prefillValidUntil('2026-02-30')).toThrow(RangeError);
  });

  it('一致時不提示', () => {
    expect(checkValidUntilConsistency('2026-11-08', '2030-11-08')).toEqual({
      consistent: true,
      expected: '2030-11-08',
      message: null,
    });
  });

  it('不一致時提示預期日期，但不阻擋（以營運者依 resim 登錄的為準）', () => {
    expect(checkValidUntilConsistency('2026-11-08', '2031-01-15')).toEqual({
      consistent: false,
      expected: '2030-11-08',
      message: '效期與發證日加 4 年（2030-11-08）不一致，請確認證書',
    });
  });
});

describe('標章', () => {
  it('文字固定為「證書資料已核對」加核對日', () => {
    expect(CERTIFICATE_BADGE_TEXT).toBe('證書資料已核對');
    expect(certificateBadge('2026-11-08')).toEqual({
      text: '證書資料已核對',
      checkedOn: '2026-11-08',
      display: '證書資料已核對 2026-11-08',
    });
  });

  it('核對日不是有效日期時拋 RangeError', () => {
    expect(() => certificateBadge('2026/11/08')).toThrow(RangeError);
  });

  it('標章文字不含禁用字樣', () => {
    expect(containsForbiddenBadgeWord(certificateBadge('2026-11-08').display)).toBe(false);
  });

  it.each(FORBIDDEN_BADGE_WORDS.map((w) => [w]))('偵測禁用字樣 %s', (word) => {
    expect(containsForbiddenBadgeWord(`本證書${word}`)).toBe(true);
  });

  it('禁用字樣是「保證合法」「認證」「擔保」', () => {
    expect([...FORBIDDEN_BADGE_WORDS]).toEqual(['保證合法', '認證', '擔保']);
  });
});

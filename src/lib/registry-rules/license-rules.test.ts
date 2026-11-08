import { describe, expect, it } from 'vitest';
import {
  LICENSE_KINDS,
  REQUIRED_BUSINESS_ITEM_CODE,
  checkLicenseEligibility,
  decideRegistrationLoss,
  isRegistrationApproved,
  type LicenseEligibilityInput,
} from './license-rules';

describe('REQUIRED_BUSINESS_ITEM_CODE（P0-03）', () => {
  it('代管 H706011，包租 H706021，經紀 H704031', () => {
    expect(REQUIRED_BUSINESS_ITEM_CODE).toEqual({
      management: 'H706011',
      master_lease: 'H706021',
      brokerage: 'H704031',
    });
    expect(LICENSE_KINDS).toEqual(['management', 'master_lease', 'brokerage']);
  });
});

describe('checkLicenseEligibility', () => {
  type Row = [string, LicenseEligibilityInput, string[]];
  // 預期原因以 `code:代碼或空` 表示。空陣列代表通過。
  const rows: Row[] = [
    ['代管，公司，含 H706011', { kind: 'management', entityType: 'company', businessItemCodes: ['H706011'] }, []],
    ['代管，公司，H706011 加其他', { kind: 'management', entityType: 'company', businessItemCodes: ['H703100', 'H706011'] }, []],
    ['包租，公司，含 H706021', { kind: 'master_lease', entityType: 'company', businessItemCodes: ['H706021'] }, []],
    ['經紀，公司，含 H704031', { kind: 'brokerage', entityType: 'company', businessItemCodes: ['H704031'] }, []],
    ['經紀，商號，含 H704031（經紀得為商號）', { kind: 'brokerage', entityType: 'firm', businessItemCodes: ['H704031'] }, []],
    ['代管，公司，只有 H703100（P0-03 AC2）', { kind: 'management', entityType: 'company', businessItemCodes: ['H703100'] }, ['missing_business_item:H706011']],
    ['包租，公司，只有 H706011', { kind: 'master_lease', entityType: 'company', businessItemCodes: ['H706011'] }, ['missing_business_item:H706021']],
    ['經紀，公司，沒有任何項目', { kind: 'brokerage', entityType: 'company', businessItemCodes: [] }, ['missing_business_item:H704031']],
    ['代管，商號（P0-03 AC3）', { kind: 'management', entityType: 'firm', businessItemCodes: ['H706011'] }, ['company_required:']],
    ['包租，商號，缺項目', { kind: 'master_lease', entityType: 'firm', businessItemCodes: ['H703100'] }, ['company_required:', 'missing_business_item:H706021']],
    ['代碼大小寫與空白', { kind: 'management', entityType: 'company', businessItemCodes: [' h706011 '] }, []],
  ];

  it.each(rows)('%s', (_name, input, expected) => {
    const result = checkLicenseEligibility(input);
    if (expected.length === 0) {
      expect(result).toEqual({ ok: true });
      return;
    }
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.map((r) => `${r.code}:${'missing' in r ? r.missing : ''}`)).toEqual(expected);
  });

  it('原因附給畫面用的訊息，缺項目時顯示代碼', () => {
    const result = checkLicenseEligibility({ kind: 'management', entityType: 'company', businessItemCodes: ['H703100'] });
    expect(result).toEqual({
      ok: false,
      reasons: [{ code: 'missing_business_item', kind: 'management', missing: 'H706011', message: '缺少營業項目 H706011' }],
    });
  });

  it('商號登錄代管時的訊息說明租賃線限公司', () => {
    const result = checkLicenseEligibility({ kind: 'management', entityType: 'firm', businessItemCodes: ['H706011'] });
    expect(result).toEqual({
      ok: false,
      reasons: [{ code: 'company_required', kind: 'management', message: '代管與包租業別必須由公司登錄（租賃線限公司）' }],
    });
  });
});

describe('isRegistrationApproved', () => {
  it.each([
    ['核准設立', true],
    [' 核准設立 ', true],
    ['停業', false],
    ['解散', false],
    ['撤銷', false],
    ['', false],
  ])('%s -> %s', (status, expected) => {
    expect(isRegistrationApproved(status)).toBe(expected);
  });
});

describe('decideRegistrationLoss（ADR-0017 決議 4、5）', () => {
  const licenses = [
    { id: 'lic-1', state: 'verified' as const },
    { id: 'lic-2', state: 'verified' as const },
    { id: 'lic-3', state: 'pending' as const },
    { id: 'lic-4', state: 'lapsed' as const },
  ];

  it('登記狀態不是核准設立時，所有已驗證的業別轉 lapsed', () => {
    const result = decideRegistrationLoss({ registrationStatus: '停業', licenses });
    expect(result.map((r) => [r.licenseId, r.transition.to, r.transition.event])).toEqual([
      ['lic-1', 'lapsed', 'registration_lost'],
      ['lic-2', 'lapsed', 'registration_lost'],
    ]);
  });

  it('登記狀態是核准設立時不動', () => {
    expect(decideRegistrationLoss({ registrationStatus: '核准設立', licenses })).toEqual([]);
  });

  it('沒有已驗證的業別時回傳空陣列', () => {
    expect(decideRegistrationLoss({ registrationStatus: '解散', licenses: [licenses[2], licenses[3]] })).toEqual([]);
  });
});

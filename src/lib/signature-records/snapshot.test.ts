import { describe, expect, it } from 'vitest';
import { createSeedPracticeRegistry } from '../practice-registry';
import { buildCredentialSnapshot, maskCertificateNo, unavailableSnapshot } from './snapshot';

const TODAY = '2026-11-09';
const AT = '2026-11-09T12:00:00+08:00';
const registry = createSeedPracticeRegistry({ today: () => TODAY });

describe('maskCertificateNo', () => {
  it('只留最後三碼', () => {
    expect(maskCertificateNo('RHM-0100200')).toBe('********200');
  });
  it('短於或等於三碼時全遮', () => {
    expect(maskCertificateNo('123')).toBe('***');
    expect(maskCertificateNo('12')).toBe('**');
  });
  it('沒有證號時回 null', () => {
    expect(maskCertificateNo(null)).toBeNull();
    expect(maskCertificateNo('')).toBeNull();
  });
});

describe('buildCredentialSnapshot', () => {
  it('含證書種類、遮罩證號、valid_until、三層狀態、三層最新核對紀錄 ID、判定時點與結果', async () => {
    const chen = (await registry.getPractitioner('pr-chen', { licenseKind: 'master_lease' }))!;
    const snapshot = buildCredentialSnapshot(chen, AT);
    expect(snapshot).toEqual({
      decidedAt: AT,
      certificateKind: 'rental_housing_manager',
      certificateNoMasked: expect.stringMatching(/^\*+\d{3}$/),
      validUntil: '2029-05-09',
      layers: {
        license: { state: 'verified', validUntil: null, latestCheckId: 'chk-org-pe-beichen-master_lease' },
        practitioner: { state: 'verified', validUntil: '2029-05-09', latestCheckId: 'chk-cert-pr-chen' },
        employment: { state: 'verified', startsOn: '2024-11-09', endsOn: null, latestCheckId: 'chk-emp-pr-chen' },
      },
      result: { signable: true, renewalWindow: null },
    });
  });

  it('不含證號原文、身分證字號與地址', async () => {
    const chen = (await registry.getPractitioner('pr-chen', { licenseKind: 'master_lease' }))!;
    const text = JSON.stringify(buildCredentialSnapshot(chen, AT));
    expect(text).not.toContain(chen.certificateNo!);
    expect(text).not.toMatch(/nationalId|idNumber|address|身分證/i);
  });

  it('判定結果用傳入的時點：同一位執業人員在證書期滿後不可簽章', async () => {
    const chen = (await registry.getPractitioner('pr-chen', { licenseKind: 'master_lease' }))!;
    const later = buildCredentialSnapshot(chen, '2029-06-01T10:00:00+08:00');
    expect(later.decidedAt).toBe('2029-06-01T10:00:00+08:00');
    expect(later.result.signable).toBe(false);
  });
});

describe('unavailableSnapshot', () => {
  it('查不到登錄資料時只留判定時點與原因', () => {
    expect(unavailableSnapshot(AT, '登錄資料來源不可用')).toEqual({
      decidedAt: AT,
      unavailable: true,
      reason: '登錄資料來源不可用',
    });
  });
});

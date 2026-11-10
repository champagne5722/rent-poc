import { describe, expect, it } from 'vitest';
import {
  checkLeasingAuthorityPreconditions,
  requiredDocumentsFor,
  type LeasingAuthoritySendFacts,
  type PrimaryLeasingAuthorityFacts,
} from './index';

const OWNERSHIP_OK: PrimaryLeasingAuthorityFacts = {
  id: '01JAUTHOWNER0000000000000',
  kind: 'ownership',
  status: 'verified',
  providedDocuments: ['registry_transcript', 'transcript_obtained_at'],
  trust: { registered: false },
};

const SUBLEASE_OK: PrimaryLeasingAuthorityFacts = {
  id: '01JAUTHSUBLEASE0000000000',
  kind: 'sublease_consent',
  status: 'verified',
  providedDocuments: ['sublease_consent_letter'],
  upstream: [{ id: '01JAUTHUPSTREAM0000000000', kind: 'ownership', status: 'verified' }],
  lessorIsVerifiedPracticeEntity: true,
};

const BASE: LeasingAuthoritySendFacts = {
  rentalUnitId: '01JUNIT000000000000000000',
  primaryAuthority: OWNERSHIP_OK,
  propertyNotVerified: false,
  hasPendingSuspectedDuplicate: false,
};

function codes(facts: LeasingAuthoritySendFacts) {
  return checkLeasingAuthorityPreconditions(facts).reasons.map((reason) => reason.code);
}

describe('checkLeasingAuthorityPreconditions：擋下原因', () => {
  const cases: Array<{ name: string; facts: LeasingAuthoritySendFacts; expected: string[] }> = [
    {
      name: '沒有主要出租權源',
      facts: { ...BASE, primaryAuthority: null },
      expected: ['no_primary_authority'],
    },
    {
      name: '沒有主要出租權源且物件沒有節點（只列物件的原因）',
      facts: { ...BASE, primaryAuthority: null, propertyNotVerified: true },
      expected: ['property_not_verified'],
    },
    {
      name: '主要出租權源待驗證',
      facts: { ...BASE, primaryAuthority: { ...OWNERSHIP_OK, status: 'pending_verification' } },
      expected: ['primary_authority_pending'],
    },
    {
      name: '主要出租權源驗證失敗',
      facts: { ...BASE, primaryAuthority: { ...OWNERSHIP_OK, status: 'failed' } },
      expected: ['primary_authority_failed'],
    },
    {
      name: '主要出租權源已失效',
      facts: { ...BASE, primaryAuthority: { ...OWNERSHIP_OK, status: 'lapsed' } },
      expected: ['primary_authority_lapsed'],
    },
    {
      name: '所有權缺謄本',
      facts: { ...BASE, primaryAuthority: { ...OWNERSHIP_OK, providedDocuments: ['transcript_obtained_at'] } },
      expected: ['missing_documents'],
    },
    {
      name: '信託登記缺四項資料',
      facts: {
        ...BASE,
        primaryAuthority: { ...OWNERSHIP_OK, trust: { registered: true, providedItems: ['trust_registered_owner'] } },
      },
      expected: ['missing_documents'],
    },
    {
      name: '轉租同意沒有已登錄的上游',
      facts: { ...BASE, primaryAuthority: { ...SUBLEASE_OK, upstream: [] } },
      expected: ['missing_documents'],
    },
    {
      name: '上游待驗證',
      facts: {
        ...BASE,
        primaryAuthority: {
          ...SUBLEASE_OK,
          upstream: [{ id: '01JAUTHUPSTREAM0000000000', kind: 'ownership', status: 'pending_verification' }],
        },
      },
      expected: ['upstream_not_verified'],
    },
    {
      name: '授權的上游驗證失敗',
      facts: {
        ...BASE,
        primaryAuthority: {
          id: '01JAUTHAUTHZ0000000000000',
          kind: 'authorization',
          status: 'verified',
          providedDocuments: ['authorization_letter'],
          upstream: [{ id: '01JAUTHUPSTREAM0000000000', kind: 'ownership', status: 'failed' }],
        },
      },
      expected: ['upstream_not_verified'],
    },
    {
      name: '轉租同意的出租人不是已驗證的執業主體',
      facts: { ...BASE, primaryAuthority: { ...SUBLEASE_OK, lessorIsVerifiedPracticeEntity: false } },
      expected: ['lessor_not_verified_practice_entity'],
    },
    {
      name: '物件尚未通過平台的文件核對',
      facts: { ...BASE, propertyNotVerified: true },
      expected: ['property_not_verified'],
    },
  ];

  it.each(cases)('$name 時擋下', ({ facts, expected }) => {
    const result = checkLeasingAuthorityPreconditions(facts);
    expect(result.blocked).toBe(true);
    expect(result.reasons.map((reason) => reason.code)).toEqual(expected);
    for (const reason of result.reasons) expect(reason.message.length).toBeGreaterThan(0);
  });
});

describe('checkLeasingAuthorityPreconditions：放行', () => {
  const cases: Array<{ name: string; facts: LeasingAuthoritySendFacts }> = [
    { name: '所有權已驗證、文件齊', facts: BASE },
    { name: '轉租同意已驗證、上游已驗證、出租人是已驗證執業主體', facts: { ...BASE, primaryAuthority: SUBLEASE_OK } },
    {
      name: '信託登記且四項齊',
      facts: {
        ...BASE,
        primaryAuthority: {
          ...OWNERSHIP_OK,
          trust: {
            registered: true,
            providedItems: [
              'trust_registered_owner',
              'trust_parties',
              'trust_registration_status',
              'trust_leasing_power_clause',
            ],
          },
        },
      },
    },
    { name: '只有疑似重複待審', facts: { ...BASE, hasPendingSuspectedDuplicate: true } },
  ];

  it.each(cases)('$name 時放行', ({ facts }) => {
    expect(checkLeasingAuthorityPreconditions(facts)).toEqual({ blocked: false, reasons: [] });
  });

  it('不再產生「出租權源未驗證」的告知事實（MIL-205）', () => {
    const result = checkLeasingAuthorityPreconditions({
      ...BASE,
      primaryAuthority: { ...OWNERSHIP_OK, status: 'pending_verification' },
    });
    expect(result).not.toHaveProperty('facts');
  });

  it('待驗證又缺件時，兩項原因都列出', () => {
    expect(
      codes({ ...BASE, primaryAuthority: { ...OWNERSHIP_OK, status: 'pending_verification', providedDocuments: [] } }),
    ).toEqual(['primary_authority_pending', 'missing_documents']);
  });
});

describe('checkLeasingAuthorityPreconditions：多重原因與說明', () => {
  it('多項同時成立時依固定順序全部列出', () => {
    expect(
      codes({
        ...BASE,
        primaryAuthority: {
          ...SUBLEASE_OK,
          status: 'failed',
          providedDocuments: [],
          upstream: [{ id: '01JAUTHUPSTREAM0000000000', kind: 'ownership', status: 'lapsed' }],
          lessorIsVerifiedPracticeEntity: false,
        },
        propertyNotVerified: true,
        hasPendingSuspectedDuplicate: true,
      }),
    ).toEqual([
      'primary_authority_failed',
      'missing_documents',
      'upstream_not_verified',
      'lessor_not_verified_practice_entity',
      'property_not_verified',
    ]);
  });

  it('沒有主要出租權源加物件尚未核對，只列物件尚未核對', () => {
    expect(codes({ ...BASE, primaryAuthority: null, propertyNotVerified: true })).toEqual(['property_not_verified']);
  });

  it('缺件原因列出全部缺件，含信託缺的項目', () => {
    const [reason] = checkLeasingAuthorityPreconditions({
      ...BASE,
      primaryAuthority: {
        ...OWNERSHIP_OK,
        providedDocuments: ['transcript_obtained_at'],
        trust: { registered: true, providedItems: ['trust_registered_owner', 'trust_parties'] },
      },
    }).reasons;
    expect(reason.missingDocuments).toEqual([
      'registry_transcript',
      'trust_registration_status',
      'trust_leasing_power_clause',
    ]);
    expect(reason.message).toContain('第二類謄本');
    expect(reason.message).toContain('信託登記狀態');
    expect(reason.message).toContain('出租權限條款');
  });

  it('上游原因列出不是已驗證的上游 ID', () => {
    const [reason] = checkLeasingAuthorityPreconditions({
      ...BASE,
      primaryAuthority: {
        ...SUBLEASE_OK,
        upstream: [
          { id: 'UP-A', kind: 'ownership', status: 'verified' },
          { id: 'UP-B', kind: 'authorization', status: 'pending_verification' },
        ],
      },
    }).reasons;
    expect(reason.code).toBe('upstream_not_verified');
    expect(reason.upstreamAuthorityIds).toEqual(['UP-B']);
  });

  it('物件尚未核對的原因說明要通過核對，不含審核單號，也不說明鍵重複（ADR-0028 決議 5）', () => {
    const [reason] = checkLeasingAuthorityPreconditions({
      ...BASE,
      propertyNotVerified: true,
    }).reasons;
    expect(reason.message).toBe('物件尚未通過平台的文件核對。通過後才能送簽。');
    expect(reason.message).not.toMatch(/審核單號|已在平台登錄|已送審核|撞號|重複/);
  });

  it('驗證失敗與已失效的說明不同', () => {
    const [failed] = checkLeasingAuthorityPreconditions({
      ...BASE,
      primaryAuthority: { ...OWNERSHIP_OK, status: 'failed' },
    }).reasons;
    const [lapsed] = checkLeasingAuthorityPreconditions({
      ...BASE,
      primaryAuthority: { ...OWNERSHIP_OK, status: 'lapsed' },
    }).reasons;
    expect(failed.message).toContain('驗證失敗');
    expect(lapsed.message).toContain('已失效');
  });
});

describe('requiredDocumentsFor：ADR-0026 決議 6 的必要文件', () => {
  it.each([
    ['ownership', false, ['registry_transcript', 'transcript_obtained_at']],
    [
      'ownership',
      true,
      [
        'registry_transcript',
        'transcript_obtained_at',
        'trust_registered_owner',
        'trust_parties',
        'trust_registration_status',
        'trust_leasing_power_clause',
      ],
    ],
    ['authorization', false, ['authorization_letter', 'registered_upstream']],
    ['sublease_consent', false, ['sublease_consent_letter', 'registered_upstream']],
  ] as const)('%s（信託登記 %s）', (kind, trustRegistered, expected) => {
    expect(requiredDocumentsFor(kind, trustRegistered)).toEqual(expected);
  });
});

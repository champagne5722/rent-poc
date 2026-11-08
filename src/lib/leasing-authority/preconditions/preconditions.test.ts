import { describe, expect, it } from 'vitest';
import {
  checkLeasingAuthorityPreconditions,
  requiredDocumentsFor,
  UNVERIFIED_AUTHORITY_TEXT,
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
  pendingKeyCollision: null,
  hasPendingSuspectedDuplicate: false,
};

function codes(facts: LeasingAuthoritySendFacts) {
  return checkLeasingAuthorityPreconditions(facts).reasons.map((reason) => reason.code);
}

describe('checkLeasingAuthorityPreconditions：六項擋下原因', () => {
  const cases: Array<{ name: string; facts: LeasingAuthoritySendFacts; expected: string[] }> = [
    {
      name: '沒有主要出租權源',
      facts: { ...BASE, primaryAuthority: null },
      expected: ['no_primary_authority'],
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
      name: '租賃單位有待審的撞號',
      facts: { ...BASE, pendingKeyCollision: { reviewItemId: 'REV-0042' } },
      expected: ['pending_key_collision'],
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

  it.each(cases)('$name 時放行且沒有事實', ({ facts }) => {
    expect(checkLeasingAuthorityPreconditions(facts)).toEqual({ blocked: false, reasons: [], facts: [] });
  });

  it('主要出租權源待驗證時放行，事實帶「出租權源未驗證」', () => {
    const result = checkLeasingAuthorityPreconditions({
      ...BASE,
      primaryAuthority: { ...OWNERSHIP_OK, status: 'pending_verification' },
    });
    expect(result.blocked).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(result.facts).toEqual([
      { code: 'leasing_authority_unverified', text: '出租權源未驗證', authorityId: OWNERSHIP_OK.id },
    ]);
    expect(UNVERIFIED_AUTHORITY_TEXT).toBe('出租權源未驗證');
  });

  it('待驗證但另有擋下原因時，擋下並仍帶未驗證事實', () => {
    const result = checkLeasingAuthorityPreconditions({
      ...BASE,
      primaryAuthority: { ...OWNERSHIP_OK, status: 'pending_verification', providedDocuments: [] },
    });
    expect(result.blocked).toBe(true);
    expect(result.reasons.map((reason) => reason.code)).toEqual(['missing_documents']);
    expect(result.facts.map((fact) => fact.code)).toEqual(['leasing_authority_unverified']);
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
        pendingKeyCollision: { reviewItemId: 'REV-0042' },
        hasPendingSuspectedDuplicate: true,
      }),
    ).toEqual([
      'primary_authority_failed',
      'missing_documents',
      'upstream_not_verified',
      'lessor_not_verified_practice_entity',
      'pending_key_collision',
    ]);
  });

  it('沒有主要出租權源加撞號待審，兩項都列出', () => {
    expect(codes({ ...BASE, primaryAuthority: null, pendingKeyCollision: { reviewItemId: 'REV-0042' } })).toEqual([
      'no_primary_authority',
      'pending_key_collision',
    ]);
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

  it('撞號原因帶審核單號，說明待審', () => {
    const [reason] = checkLeasingAuthorityPreconditions({
      ...BASE,
      pendingKeyCollision: { reviewItemId: 'REV-0042' },
    }).reasons;
    expect(reason.message).toContain('REV-0042');
    expect(reason.message).toContain('審核');
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

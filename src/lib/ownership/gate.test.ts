import { describe, expect, it } from 'vitest';
import { checkLeasingAuthorityPreconditions } from '../leasing-authority/preconditions';
import { checkSendPreconditions } from '../send-preconditions';
import {
  canCreateCase,
  canSendContract,
  leasingAuthorityFactsOf,
  PROPERTY_NOT_VERIFIED_CODE,
  PROPERTY_NOT_VERIFIED_MESSAGE,
  type OwnershipGate,
} from './gate';
import type { OwnershipStatus } from './status';

// MIL-205：節點的四種狀態加上沒有節點，對「建立案件」與「送簽」各自的結果。表格測試。

const NODE = { id: '01JNODE0000000000000000000', hasSubmission: true, trustRegistered: false, trustItemsProvided: [] };
const gateOf = (status: OwnershipStatus | null, node: Partial<OwnershipGate['node'] & object> = {}): OwnershipGate =>
  status === null ? { nodeStatus: null, node: null } : { nodeStatus: status, node: { ...NODE, ...node } };

const TABLE: Array<{ name: string; status: OwnershipStatus | null; create: boolean; send: boolean; sendReasons: string[] }> = [
  { name: '已驗證', status: 'verified', create: true, send: true, sendReasons: [] },
  { name: '待驗證', status: 'pending_verification', create: false, send: false, sendReasons: ['primary_authority_pending'] },
  { name: '驗證失敗', status: 'failed', create: false, send: false, sendReasons: ['primary_authority_failed'] },
  { name: '已失效', status: 'lapsed', create: false, send: false, sendReasons: ['primary_authority_lapsed'] },
  { name: '沒有節點', status: null, create: false, send: false, sendReasons: ['property_not_verified'] },
];

describe('節點狀態對建立案件與送簽的結果', () => {
  it.each(TABLE)('$name：建立案件 $create，送簽 $send', ({ status, create, send, sendReasons }) => {
    const gate = gateOf(status);
    expect(canCreateCase(gate)).toBe(create);
    expect(canSendContract(gate)).toBe(send);
    const result = checkLeasingAuthorityPreconditions(leasingAuthorityFactsOf('RU', gate));
    expect(result.blocked).toBe(!send);
    expect(result.reasons.map((r) => r.code)).toEqual(sendReasons);
  });

  it('只有已驗證的節點能放行：其他狀態都擋下', () => {
    expect(TABLE.filter((row) => row.create).map((row) => row.status)).toEqual(['verified']);
    expect(TABLE.filter((row) => row.send).map((row) => row.status)).toEqual(['verified']);
  });

  it('沒有節點的原因文字固定，不提到別人，也不說鍵重複', () => {
    expect(PROPERTY_NOT_VERIFIED_MESSAGE).toBe('物件尚未通過平台的文件核對');
    expect(PROPERTY_NOT_VERIFIED_CODE).toBe('property_not_verified');
    expect(PROPERTY_NOT_VERIFIED_MESSAGE).not.toMatch(/審核單號|已在平台登錄|已送審核|撞號|重複/);
  });
});

describe('送簽的權源事實', () => {
  it('沒有節點：沒有主要出租權源，物件尚未核對', () => {
    expect(leasingAuthorityFactsOf('RU', gateOf(null))).toEqual({
      rentalUnitId: 'RU',
      primaryAuthority: null,
      propertyNotVerified: true,
      hasPendingSuspectedDuplicate: false,
    });
  });

  it('有節點：主要出租權源是所有權，狀態取自節點，不另列物件原因', () => {
    const facts = leasingAuthorityFactsOf('RU', gateOf('failed'));
    expect(facts.propertyNotVerified).toBe(false);
    expect(facts.primaryAuthority).toMatchObject({ id: NODE.id, kind: 'ownership', status: 'failed' });
  });

  it('信託登記的四項資料不齊時，已驗證的節點也因缺件被擋下', () => {
    const gate = gateOf('verified', { trustRegistered: true, trustItemsProvided: ['trust_registered_owner'] });
    const result = checkLeasingAuthorityPreconditions(leasingAuthorityFactsOf('RU', gate));
    expect(result.reasons.map((r) => r.code)).toEqual(['missing_documents']);
  });

  it('信託登記的四項資料齊時放行', () => {
    const gate = gateOf('verified', {
      trustRegistered: true,
      trustItemsProvided: ['trust_registered_owner', 'trust_parties', 'trust_registration_status', 'trust_leasing_power_clause'],
    });
    expect(checkLeasingAuthorityPreconditions(leasingAuthorityFactsOf('RU', gate)).blocked).toBe(false);
  });

  it('接進 checkSendPreconditions：待驗證的原因出現在送簽的原因清單，不產生告知事實', () => {
    const result = checkSendPreconditions({
      routing: { documentType: 'lease', caseKind: 'sublease', brokerMediated: false },
      at: '2026-11-10T10:00:00+08:00',
      entities: {},
      signers: [],
      registryAvailable: true,
      leasingAuthority: leasingAuthorityFactsOf('RU', gateOf('pending_verification')),
    });
    expect(result.reasons.map((r) => r.code)).toContain('primary_authority_pending');
    expect(result).not.toHaveProperty('leasingAuthorityFacts');
  });
});

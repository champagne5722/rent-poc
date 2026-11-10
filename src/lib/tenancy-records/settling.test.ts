import { describe, expect, it } from 'vitest';
import type { BusinessType, StatutoryCaseKind } from '../cases';
import { HANDOVER_RECORD_STATES, type HandoverRecordState } from './handover-record';
import { canAdvanceToSettling, type SettlingFacts, type SettlingResult } from './settling';

const RECORD_STATES: (HandoverRecordState | null)[] = [null, ...HANDOVER_RECORD_STATES];

// 規則看案件種類，租賃案件再看業務類型（MIL-198）。轉租案件的業務類型欄位是舊值 master_lease（資料上的事實）。
// 包租案件在資料上是自管租賃，沿用自管的規則（待法務確認）。
interface CaseCombination {
  name: string;
  caseKind: StatutoryCaseKind;
  businessType: BusinessType;
  /** 是否走自管的路徑：雙方確認。否則走點交證明。 */
  selfPath: boolean;
}

const LEASE_SELF: CaseCombination = { name: '租賃自管', caseKind: 'lease', businessType: 'self_managed', selfPath: true };
const MASTER_LEASE: CaseCombination = { name: '包租', caseKind: 'master_lease', businessType: 'self_managed', selfPath: true };
const LEASE_MANAGED: CaseCombination = { name: '租賃代管', caseKind: 'lease', businessType: 'managed', selfPath: false };
const SUBLEASE: CaseCombination = { name: '轉租', caseKind: 'sublease', businessType: 'master_lease', selfPath: false };
const COMBINATIONS = [LEASE_SELF, MASTER_LEASE, LEASE_MANAGED, SUBLEASE];

function facts(
  combination: CaseCombination,
  moveOutRecordState: HandoverRecordState | null,
  certificateCompleted: boolean,
  demandNoticeRecorded: boolean,
): SettlingFacts {
  const { caseKind, businessType } = combination;
  return { caseKind, businessType, moveOutRecordState, certificateCompleted, demandNoticeRecorded };
}

const ok = (via: 'both_confirmed' | 'certificate_completed' | 'demand_notice'): SettlingResult => ({ ok: true, via });
const blocked = (...missing: Extract<SettlingResult, { ok: false }>['missing']): SettlingResult => ({
  ok: false,
  missing,
});

// 租賃自管與包租：只看雙方確認（退租點交的狀態），點交證明不適用。登錄催告後也能推進。
describe.each([LEASE_SELF, MASTER_LEASE])('canAdvanceToSettling：$name', (combination) => {
  it.each([
    [null, false, blocked('move_out_record_missing')],
    ['draft', false, blocked('lessor_unconfirmed', 'lessee_unconfirmed')],
    ['pending_lessee_confirmation', false, blocked('lessee_unconfirmed')],
    ['confirmed', false, ok('both_confirmed')],
    [null, true, ok('demand_notice')],
    ['draft', true, ok('demand_notice')],
    ['pending_lessee_confirmation', true, ok('demand_notice')],
    ['confirmed', true, ok('both_confirmed')],
  ] as const)('退租點交 %s、催告 %s', (record, notice, expected) => {
    expect(canAdvanceToSettling(facts(combination, record, false, notice))).toEqual(expected);
  });

  it('點交證明完成不算數', () => {
    expect(canAdvanceToSettling(facts(combination, 'pending_lessee_confirmation', true, false))).toEqual(
      blocked('lessee_unconfirmed'),
    );
  });
});

// 租賃代管與轉租：只看點交證明是否完成，雙方在系統內確認不算。登錄催告後也能推進。
describe.each([LEASE_MANAGED, SUBLEASE])('canAdvanceToSettling：$name', (combination) => {
  it.each([
    [false, false, blocked('certificate_incomplete')],
    [true, false, ok('certificate_completed')],
    [false, true, ok('demand_notice')],
    [true, true, ok('certificate_completed')],
  ] as const)('點交證明完成 %s、催告 %s', (certificate, notice, expected) => {
    expect(canAdvanceToSettling(facts(combination, 'confirmed', certificate, notice))).toEqual(expected);
  });

  it.each(RECORD_STATES)('退租點交 %s 對結果沒有影響', (record) => {
    expect(canAdvanceToSettling(facts(combination, record, false, false))).toEqual(blocked('certificate_incomplete'));
    expect(canAdvanceToSettling(facts(combination, record, true, false))).toEqual(ok('certificate_completed'));
  });
});

describe('canAdvanceToSettling：全組合', () => {
  const ALL = COMBINATIONS.flatMap((combination) =>
    RECORD_STATES.flatMap((record) =>
      [false, true].flatMap((cert) => [false, true].map((notice) => [combination, record, cert, notice] as const)),
    ),
  );

  it.each(ALL)('%o、退租點交 %s、證明 %s、催告 %s：只有三條通過路徑，其餘都列出缺少的前提', (combination, record, cert, notice) => {
    const result = canAdvanceToSettling(facts(combination, record, cert, notice));
    const primary = combination.selfPath ? record === 'confirmed' : cert;
    expect(result.ok).toBe(primary || notice);
    if (!result.ok) expect(result.missing.length).toBeGreaterThan(0);
  });

  it('不認得的案件種類或租賃案件的業務類型丟 RangeError，不當成代管處理', () => {
    const unknownKind = { ...LEASE_SELF, caseKind: 'foo' as StatutoryCaseKind };
    const unknownBusinessType = { ...LEASE_SELF, businessType: 'foo' as BusinessType };
    expect(() => canAdvanceToSettling(facts(unknownKind, 'confirmed', true, true))).toThrow(RangeError);
    expect(() => canAdvanceToSettling(facts(unknownBusinessType, 'confirmed', true, true))).toThrow(RangeError);
  });

  it('登錄催告時，缺少的前提不會出現', () => {
    const result = canAdvanceToSettling(facts(LEASE_MANAGED, null, false, true));
    expect(result).toEqual(ok('demand_notice'));
  });
});

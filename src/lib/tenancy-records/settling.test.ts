import { describe, expect, it } from 'vitest';
import { BUSINESS_TYPES, type BusinessType } from '../cases';
import { HANDOVER_RECORD_STATES, type HandoverRecordState } from './handover-record';
import { canAdvanceToSettling, type SettlingFacts, type SettlingResult } from './settling';

const RECORD_STATES: (HandoverRecordState | null)[] = [null, ...HANDOVER_RECORD_STATES];

function facts(
  businessType: BusinessType,
  moveOutRecordState: HandoverRecordState | null,
  certificateCompleted: boolean,
  demandNoticeRecorded: boolean,
): SettlingFacts {
  return { businessType, moveOutRecordState, certificateCompleted, demandNoticeRecorded };
}

const ok = (via: 'both_confirmed' | 'certificate_completed' | 'demand_notice'): SettlingResult => ({ ok: true, via });
const blocked = (...missing: Extract<SettlingResult, { ok: false }>['missing']): SettlingResult => ({
  ok: false,
  missing,
});

// 自管：只看雙方確認（退租點交的狀態），點交證明不適用。登錄催告後也能推進。
describe('canAdvanceToSettling：自管', () => {
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
    expect(canAdvanceToSettling(facts('self_managed', record, false, notice))).toEqual(expected);
  });

  it('點交證明完成不算數', () => {
    expect(canAdvanceToSettling(facts('self_managed', 'pending_lessee_confirmation', true, false))).toEqual(
      blocked('lessee_unconfirmed'),
    );
  });
});

// 代管與包租：只看點交證明是否完成，雙方在系統內確認不算。登錄催告後也能推進。
describe.each(['managed', 'master_lease'] as const)('canAdvanceToSettling：%s', (businessType) => {
  it.each([
    [false, false, blocked('certificate_incomplete')],
    [true, false, ok('certificate_completed')],
    [false, true, ok('demand_notice')],
    [true, true, ok('certificate_completed')],
  ] as const)('點交證明完成 %s、催告 %s', (certificate, notice, expected) => {
    expect(canAdvanceToSettling(facts(businessType, 'confirmed', certificate, notice))).toEqual(expected);
  });

  it.each(RECORD_STATES)('退租點交 %s 對結果沒有影響', (record) => {
    expect(canAdvanceToSettling(facts(businessType, record, false, false))).toEqual(blocked('certificate_incomplete'));
    expect(canAdvanceToSettling(facts(businessType, record, true, false))).toEqual(ok('certificate_completed'));
  });
});

describe('canAdvanceToSettling：全組合', () => {
  const ALL = BUSINESS_TYPES.flatMap((type) =>
    RECORD_STATES.flatMap((record) =>
      [false, true].flatMap((cert) => [false, true].map((notice) => [type, record, cert, notice] as const)),
    ),
  );

  it.each(ALL)('%s、退租點交 %s、證明 %s、催告 %s：只有三條通過路徑，其餘都列出缺少的前提', (type, record, cert, notice) => {
    const result = canAdvanceToSettling(facts(type, record, cert, notice));
    const primary =
      type === 'self_managed' ? record === 'confirmed' : cert;
    expect(result.ok).toBe(primary || notice);
    if (!result.ok) expect(result.missing.length).toBeGreaterThan(0);
  });

  it('不認得的業務類型丟 RangeError，不當成代管處理', () => {
    expect(() => canAdvanceToSettling(facts('foo' as BusinessType, 'confirmed', true, true))).toThrow(RangeError);
  });

  it('登錄催告時，缺少的前提不會出現', () => {
    const result = canAdvanceToSettling(facts('managed', null, false, true));
    expect(result).toEqual(ok('demand_notice'));
  });
});

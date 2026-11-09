import { describe, expect, it } from 'vitest';
import type { ContractRoutingConditions } from '../types';
import { evaluateRouting, hasPractitionerSeat, printOrder, routingInputError } from './seats';

describe('printOrder（簽署序列換成印列順序）', () => {
  it('印列順序固定為甲方、乙方、執業人員，與簽署順序無關', () => {
    const result = evaluateRouting({ businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: true });
    if (!result.ok) throw new Error(result.reason);
    expect(result.seats.map((s) => s.role)).toEqual(['party_b', 'practitioner', 'party_a', 'practitioner']);
    expect(printOrder(result.seats).map((s) => s.label)).toEqual([
      '甲方',
      '乙方',
      '執業人員（租賃住宅管理人員）',
      '執業人員（不動產經紀人）',
    ]);
  });

  it('兩方序列印成甲方、乙方', () => {
    const result = evaluateRouting(undefined);
    if (!result.ok) throw new Error(result.reason);
    expect(printOrder(result.seats).map((s) => s.role)).toEqual(['party_a', 'party_b']);
  });
});

describe('routingInputError（存草稿時檢查分流條件的形狀）', () => {
  it('沒有帶分流條件、形狀正確的值都通過', () => {
    expect(routingInputError(undefined)).toBeNull();
    expect(routingInputError({ businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: true })).toBeNull();
  });

  it('規則未定義的組合只是不能往下走，草稿仍可保存', () => {
    expect(routingInputError({ businessType: 'managed', lesseeIsMasterLessor: true, brokerMediated: false })).toBeNull();
  });

  it('缺鍵、型別不對、不認得的業務類型都回傳原因', () => {
    expect(routingInputError({ businessType: 'managed' })).toContain('分流條件');
    expect(routingInputError({ businessType: 'rent', lesseeIsMasterLessor: false, brokerMediated: false })).toContain('分流條件');
    expect(routingInputError('self_managed')).toContain('分流條件');
    expect(routingInputError(null)).toContain('分流條件');
  });
});

const routing = (patch: Partial<ContractRoutingConditions> = {}): ContractRoutingConditions => ({
  businessType: 'self_managed',
  lesseeIsMasterLessor: false,
  brokerMediated: false,
  ...patch,
});

function seatsOf(stored: unknown) {
  const result = evaluateRouting(stored);
  if (!result.ok) throw new Error(`預期有簽署序列，實際被擋下：${result.reason}`);
  return result.seats;
}

describe('evaluateRouting（分流條件換成畫面用的簽署序列）', () => {
  it('沒有分流條件的合約視為自管租賃合約：乙方、甲方', () => {
    expect(seatsOf(undefined).map((s) => s.role)).toEqual(['party_b', 'party_a']);
  });

  it('包租：乙方、執業人員、甲方', () => {
    expect(seatsOf(routing({ businessType: 'master_lease' })).map((s) => s.role)).toEqual([
      'party_b',
      'practitioner',
      'party_a',
    ]);
  });

  it('自管且承租人是包租業者：甲方、執業人員、乙方', () => {
    expect(seatsOf(routing({ lesseeIsMasterLessor: true })).map((s) => s.role)).toEqual([
      'party_a',
      'practitioner',
      'party_b',
    ]);
  });

  it('包租加經紀業者居間：經紀人排在最後，與管理人員是兩個不同席位', () => {
    const seats = seatsOf(routing({ businessType: 'master_lease', brokerMediated: true }));
    expect(seats.map((s) => s.role)).toEqual(['party_b', 'practitioner', 'party_a', 'practitioner']);
    expect(new Set(seats.map((s) => s.ruleId)).size).toBe(4);
  });

  it('席位名稱用法定稱謂區分兩位執業人員', () => {
    const seats = seatsOf(routing({ businessType: 'master_lease', brokerMediated: true }));
    expect(seats.map((s) => s.label)).toEqual([
      '乙方',
      '執業人員（租賃住宅管理人員）',
      '甲方',
      '執業人員（不動產經紀人）',
    ]);
  });

  it('租賃合約的完整稱謂：甲方（出租人）、乙方（承租人）', () => {
    const seats = seatsOf(undefined);
    expect(seats.map((s) => s.fullLabel)).toEqual(['乙方（承租人）', '甲方（出租人）']);
  });

  it('只有規則要求執業人員的組合才有執業人員席位', () => {
    expect(hasPractitionerSeat(seatsOf(undefined))).toBe(false);
    expect(hasPractitionerSeat(seatsOf(routing({ businessType: 'managed' })))).toBe(false);
    expect(hasPractitionerSeat(seatsOf(routing({ businessType: 'master_lease' })))).toBe(true);
    expect(hasPractitionerSeat(seatsOf(routing({ brokerMediated: true })))).toBe(true);
  });

  it('規則表沒有定義的組合回傳原因，不給預設序列', () => {
    const managed = evaluateRouting(routing({ businessType: 'managed', lesseeIsMasterLessor: true }));
    expect(managed.ok).toBe(false);
    if (!managed.ok) {
      expect(managed.reason).toContain('代管');
      expect(managed.reason).toContain('承租人是包租業者');
    }
    const masterLease = evaluateRouting(routing({ businessType: 'master_lease', lesseeIsMasterLessor: true }));
    expect(masterLease.ok).toBe(false);
    if (!masterLease.ok) expect(masterLease.reason).toContain('包租');
  });

  it('形狀不對的分流條件被擋下，不退回預設值', () => {
    const result = evaluateRouting({ businessType: 'managed' });
    expect(result.ok).toBe(false);
  });
});

describe('委託管理合約的席位（MIL-74）', () => {
  it('沒有分流條件時是代管，序列為甲方、執業人員、乙方，稱謂用委託人與受託人', () => {
    const result = evaluateRouting(undefined, 'management');
    if (!result.ok) throw new Error(result.reason);
    expect(result.seats.map((s) => s.role)).toEqual(['party_a', 'practitioner', 'party_b']);
    expect(result.seats.map((s) => s.fullLabel)).toEqual([
      '甲方（委託人）',
      '執業人員（租賃住宅管理人員）',
      '乙方（受託人）',
    ]);
    expect(result.seats.map((s) => s.label)).toEqual(['甲方', '執業人員（租賃住宅管理人員）', '乙方']);
  });

  it('印列順序是甲方、乙方、執業人員', () => {
    const result = evaluateRouting(undefined, 'management');
    if (!result.ok) throw new Error(result.reason);
    expect(printOrder(result.seats).map((s) => s.fullLabel)).toEqual([
      '甲方（委託人）',
      '乙方（受託人）',
      '執業人員（租賃住宅管理人員）',
    ]);
  });

  it('租賃合約沒有帶類型時稱謂不變', () => {
    const result = evaluateRouting(undefined);
    if (!result.ok) throw new Error(result.reason);
    expect(result.seats.map((s) => s.fullLabel)).toEqual(['乙方（承租人）', '甲方（出租人）']);
  });

  it('委託管理合約的分流條件形狀檢查', () => {
    expect(routingInputError(undefined, 'management')).toBeNull();
    expect(routingInputError('x', 'management')).toContain('分流條件');
  });

  it('委託管理合約只存在於代管，其他業務類型被擋下並說明', () => {
    const result = evaluateRouting(
      { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: false },
      'management',
    );
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('委託管理合約') });
  });
});

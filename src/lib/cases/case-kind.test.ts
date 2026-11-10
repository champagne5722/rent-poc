import { describe, expect, it } from 'vitest';
import { caseKindOf, HOST_ORG_KINDS_FOR_CASE_KIND, isStatutoryCaseKind, STATUTORY_CASE_KINDS } from './case-kind';

// ADR-0030 決議 1、2 的對照表。期望值照 ADR 的表格逐列寫成字面值，不從實作推導。
describe('案件種類（ADR-0030）', () => {
  it('資料上有四個種類', () => {
    expect([...STATUTORY_CASE_KINDS]).toEqual(['lease', 'management', 'master_lease', 'sublease']);
  });

  it.each([
    { name: '自管租賃案件，承租人不是包租業者', kind: 'lease', businessType: 'self_managed', lessee: false, expected: 'lease' },
    { name: '代管租賃案件', kind: 'lease', businessType: 'managed', lessee: false, expected: 'lease' },
    { name: '委託管理案件', kind: 'management', businessType: null, lessee: false, expected: 'management' },
    { name: '自管租賃案件，承租人是包租業者，歸為包租案件', kind: 'lease', businessType: 'self_managed', lessee: true, expected: 'master_lease' },
    { name: '業務類型 master_lease 的租賃案件，歸為轉租案件', kind: 'lease', businessType: 'master_lease', lessee: false, expected: 'sublease' },
  ] as const)('$name → $expected', ({ kind, businessType, lessee, expected }) => {
    expect(caseKindOf({ kind, businessType, lesseeIsMasterLessor: lessee })).toBe(expected);
  });

  it('代管租賃案件的承租人是包租業者時，仍是租賃案件（ADR-0030 決議 2 沒有這一列）', () => {
    expect(caseKindOf({ kind: 'lease', businessType: 'managed', lesseeIsMasterLessor: true })).toBe('lease');
  });

  it('業務類型是 master_lease 時，承租人旗標不改變結果', () => {
    expect(caseKindOf({ kind: 'lease', businessType: 'master_lease', lesseeIsMasterLessor: true })).toBe('sublease');
  });

  it('租賃案件沒有業務類型時丟錯', () => {
    expect(() => caseKindOf({ kind: 'lease', businessType: null, lesseeIsMasterLessor: false })).toThrow();
  });

  it('isStatutoryCaseKind 只認四個值', () => {
    expect(isStatutoryCaseKind('sublease')).toBe(true);
    expect(isStatutoryCaseKind('self_managed')).toBe(false);
    expect(isStatutoryCaseKind(null)).toBe(false);
  });

  it('主辦組織：租賃案件兩種組織都能辦，其餘三種只有執業主體組織', () => {
    expect(HOST_ORG_KINDS_FOR_CASE_KIND).toEqual({
      lease: ['owner', 'practice'],
      management: ['practice'],
      master_lease: ['practice'],
      sublease: ['practice'],
    });
  });
});

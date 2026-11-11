import { describe, expect, it } from 'vitest';
import { routingSnapshotFor } from '../contract-types';
import { contractTypeForNewCase, routingForNewCase } from './property-entry';

// MIL-199 與 MIL-209 的接點：新建案件入口由案件種類決定合約類型與分流條件。純函式，不連資料庫。

describe('contractTypeForNewCase', () => {
  it('租賃案件建租賃合約，包租案件建包租合約，轉租案件建轉租合約', () => {
    expect(contractTypeForNewCase('lease')).toBe('lease');
    expect(contractTypeForNewCase('master_lease')).toBe('master_lease');
    expect(contractTypeForNewCase('sublease')).toBe('sublease');
  });
});

describe('案件的分流條件與合約的分流快照一致', () => {
  it.each([
    ['practice', 'master_lease'],
    ['practice', 'sublease'],
  ] as const)('%s 組織建 %s 案件：兩邊的分流條件相同', (orgKind, caseKind) => {
    for (const brokerMediated of [false, true]) {
      expect(routingForNewCase(orgKind, caseKind, brokerMediated)).toEqual(
        routingSnapshotFor(contractTypeForNewCase(caseKind), brokerMediated),
      );
    }
  });

  it('租賃案件沒有合約的分流快照，案件端的條件由組織種類決定', () => {
    expect(routingSnapshotFor(contractTypeForNewCase('lease'), false)).toBeUndefined();
    expect(routingForNewCase('owner', 'lease', false)).toEqual({ businessType: 'self_managed', lesseeIsMasterLessor: false, brokerMediated: false });
    expect(routingForNewCase('practice', 'lease', false)).toEqual({ businessType: 'managed', lesseeIsMasterLessor: false, brokerMediated: false });
  });

  it('組織種類不能建這種案件：案件端回 null', () => {
    expect(routingForNewCase('owner', 'master_lease', false)).toBeNull();
    expect(routingForNewCase('owner', 'sublease', false)).toBeNull();
  });
});

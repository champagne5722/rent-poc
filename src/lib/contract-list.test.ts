import { describe, expect, it } from 'vitest';
import type { Contract, ContractStatus } from './types';
import {
  compareByWorkPriority,
  countByStatus,
  lastActionAt,
  matchesFilter,
  overlapsLeaseRange,
  propertyNameOptions,
  selectContracts,
  signingProgressStep,
  EMPTY_CONTRACT_LIST_FILTER,
} from './contract-list';

interface MakeOptions {
  id?: number;
  status?: ContractStatus;
  propertyName?: string;
  startDate?: string;
  endDate?: string;
  created_at?: string;
  updated_at?: string | null;
}

function makeContract(o: MakeOptions = {}): Contract {
  return {
    id: o.id ?? 1,
    property_id: null,
    status: o.status ?? 'draft',
    fields: {
      landlordName: '林房東',
      landlordEmail: 'landlord@example.com',
      tenantName: '王租客',
      tenantEmail: 'tenant@example.com',
      propertyName: o.propertyName ?? '測試物件',
      propertyAddress: '台北市測試路 1 號',
      propertyType: '套房',
      propertySize: 10,
      equipment: [],
      rent: 15000,
      deposit: 30000,
      startDate: o.startDate ?? '2026-09-01',
      endDate: o.endDate ?? '2027-08-31',
      payDay: 5,
      extra: '',
    },
    signature_fields: [],
    dottedsign_task_id: null,
    declined_reason: null,
    derived_from: null,
    created_at: o.created_at ?? '2026-08-01 00:00:00',
    updated_at: o.updated_at === undefined ? null : o.updated_at,
  };
}

describe('lastActionAt（最後動作時間）', () => {
  it('有 updated_at 時取 updated_at', () => {
    const c = makeContract({ created_at: '2026-08-01 00:00:00', updated_at: '2026-08-02 09:30:00' });
    expect(lastActionAt(c)).toBe('2026-08-02 09:30:00');
  });

  it('沒有 updated_at 時退回 created_at', () => {
    expect(lastActionAt(makeContract({ created_at: '2026-08-01 00:00:00', updated_at: null }))).toBe(
      '2026-08-01 00:00:00'
    );
  });
});

describe('countByStatus（狀態計數）', () => {
  it('六個狀態都有值，沒有的合約算 0', () => {
    const counts = countByStatus([
      makeContract({ id: 1, status: 'draft' }),
      makeContract({ id: 2, status: 'draft' }),
      makeContract({ id: 3, status: 'awaiting_tenant' }),
      makeContract({ id: 4, status: 'completed' }),
    ]);
    expect(counts).toEqual({
      draft: 2,
      awaiting_tenant: 1,
      awaiting_landlord: 0,
      completed: 1,
      declined: 0,
      voided: 0,
    });
  });

  it('空清單時每個狀態都是 0', () => {
    expect(countByStatus([])).toEqual({
      draft: 0,
      awaiting_tenant: 0,
      awaiting_landlord: 0,
      completed: 0,
      declined: 0,
      voided: 0,
    });
  });
});

describe('propertyNameOptions（物件下拉選項）', () => {
  it('去重、略過空字串，並依名稱排序', () => {
    const items = [
      makeContract({ id: 1, propertyName: '信義套房' }),
      makeContract({ id: 2, propertyName: '中山雅房' }),
      makeContract({ id: 3, propertyName: '信義套房' }),
      makeContract({ id: 4, propertyName: '' }),
    ];
    expect(propertyNameOptions(items)).toEqual(['中山雅房', '信義套房']);
  });
});

describe('overlapsLeaseRange（租期涵蓋區間）', () => {
  const c = makeContract({ startDate: '2026-09-01', endDate: '2027-08-31' });

  it('沒有指定區間時全部命中', () => {
    expect(overlapsLeaseRange(c, null)).toBe(true);
  });

  it('區間完全落在租期內時命中', () => {
    expect(overlapsLeaseRange(c, ['2026-12-01', '2027-01-01'])).toBe(true);
  });

  it('區間與租期部分重疊時命中', () => {
    expect(overlapsLeaseRange(c, ['2026-01-01', '2026-09-01'])).toBe(true);
    expect(overlapsLeaseRange(c, ['2027-08-31', '2028-01-01'])).toBe(true);
  });

  it('區間完全在租期之前或之後時不命中', () => {
    expect(overlapsLeaseRange(c, ['2026-01-01', '2026-08-31'])).toBe(false);
    expect(overlapsLeaseRange(c, ['2027-09-01', '2027-12-31'])).toBe(false);
  });

  it('合約租期未填時不命中（無法判斷涵蓋）', () => {
    const noDates = makeContract({ startDate: '', endDate: '' });
    expect(overlapsLeaseRange(noDates, ['2026-01-01', '2027-12-31'])).toBe(false);
    expect(overlapsLeaseRange(noDates, null)).toBe(true);
  });
});

describe('matchesFilter（單筆是否命中篩選）', () => {
  const c = makeContract({ status: 'draft', propertyName: '信義套房' });

  it('狀態 all 不篩選狀態', () => {
    expect(matchesFilter(c, EMPTY_CONTRACT_LIST_FILTER)).toBe(true);
  });

  it('狀態不符時排除', () => {
    expect(matchesFilter(c, { ...EMPTY_CONTRACT_LIST_FILTER, status: 'completed' })).toBe(false);
    expect(matchesFilter(c, { ...EMPTY_CONTRACT_LIST_FILTER, status: 'draft' })).toBe(true);
  });

  it('物件不符時排除', () => {
    expect(matchesFilter(c, { ...EMPTY_CONTRACT_LIST_FILTER, propertyName: '中山雅房' })).toBe(false);
    expect(matchesFilter(c, { ...EMPTY_CONTRACT_LIST_FILTER, propertyName: '信義套房' })).toBe(true);
  });

  it('三個條件同時套用（AND）', () => {
    expect(
      matchesFilter(c, { status: 'draft', propertyName: '信義套房', leaseRange: ['2026-01-01', '2026-08-31'] })
    ).toBe(false);
  });
});

describe('compareByWorkPriority（進行中優先排序）', () => {
  it('分組順序＝簽署中 → 草稿 → 拒簽／撤回 → 已完成', () => {
    const items: Contract[] = [
      makeContract({ id: 1, status: 'completed' }),
      makeContract({ id: 2, status: 'voided' }),
      makeContract({ id: 3, status: 'draft' }),
      makeContract({ id: 4, status: 'awaiting_landlord' }),
      makeContract({ id: 5, status: 'declined' }),
      makeContract({ id: 6, status: 'awaiting_tenant' }),
    ];
    const sorted = [...items].sort(compareByWorkPriority).map((c) => c.status);
    expect(sorted.slice(0, 2).sort()).toEqual(['awaiting_landlord', 'awaiting_tenant']);
    expect(sorted[2]).toBe('draft');
    expect(sorted.slice(3, 5).sort()).toEqual(['declined', 'voided']);
    expect(sorted[5]).toBe('completed');
  });

  it('同組內依最後動作時間新到舊', () => {
    const items: Contract[] = [
      makeContract({ id: 1, status: 'awaiting_tenant', created_at: '2026-08-01 00:00:00' }),
      makeContract({ id: 2, status: 'awaiting_tenant', created_at: '2026-08-03 00:00:00' }),
      makeContract({
        id: 3,
        status: 'awaiting_landlord',
        created_at: '2026-07-01 00:00:00',
        updated_at: '2026-08-05 00:00:00',
      }),
    ];
    expect([...items].sort(compareByWorkPriority).map((c) => c.id)).toEqual([3, 2, 1]);
  });

  it('最後動作時間相同時以 id 新到舊收尾（順序穩定）', () => {
    const items: Contract[] = [
      makeContract({ id: 7, status: 'draft', created_at: '2026-08-01 00:00:00' }),
      makeContract({ id: 9, status: 'draft', created_at: '2026-08-01 00:00:00' }),
    ];
    expect([...items].sort(compareByWorkPriority).map((c) => c.id)).toEqual([9, 7]);
  });
});

describe('selectContracts（篩選＋排序）', () => {
  it('先篩選再排序，且不動到原陣列', () => {
    const items: Contract[] = [
      makeContract({ id: 1, status: 'completed', propertyName: '信義套房', created_at: '2026-08-01 00:00:00' }),
      makeContract({ id: 2, status: 'awaiting_tenant', propertyName: '信義套房', created_at: '2026-08-02 00:00:00' }),
      makeContract({ id: 3, status: 'draft', propertyName: '中山雅房', created_at: '2026-08-03 00:00:00' }),
    ];
    const snapshot = items.map((c) => c.id);

    const result = selectContracts(items, { ...EMPTY_CONTRACT_LIST_FILTER, propertyName: '信義套房' });
    expect(result.map((c) => c.id)).toEqual([2, 1]);
    expect(items.map((c) => c.id)).toEqual(snapshot);
  });

  it('租期區間可與狀態一起篩', () => {
    const items: Contract[] = [
      makeContract({ id: 1, status: 'draft', startDate: '2026-09-01', endDate: '2027-08-31' }),
      makeContract({ id: 2, status: 'draft', startDate: '2028-01-01', endDate: '2028-12-31' }),
    ];
    const result = selectContracts(items, {
      status: 'draft',
      propertyName: null,
      leaseRange: ['2027-01-01', '2027-02-01'],
    });
    expect(result.map((c) => c.id)).toEqual([1]);
  });
});

describe('signingProgressStep（簽署進度三點）', () => {
  it('待乙方簽時停在第 1 點', () => {
    expect(signingProgressStep('awaiting_tenant')).toBe(0);
  });

  it('待甲方簽時停在第 2 點', () => {
    expect(signingProgressStep('awaiting_landlord')).toBe(1);
  });

  it('已完成時三點全亮', () => {
    expect(signingProgressStep('completed')).toBe(3);
  });

  it('簽署流程外的狀態沒有進度', () => {
    expect(signingProgressStep('draft')).toBeNull();
    expect(signingProgressStep('declined')).toBeNull();
    expect(signingProgressStep('voided')).toBeNull();
  });
});

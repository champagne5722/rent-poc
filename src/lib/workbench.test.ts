import { describe, expect, it } from 'vitest';
import type { Contract, ContractStatus } from './types';
import { CONTRACT_STATUSES } from './types';
import { CREATE_CONTRACT_HREF } from './nav';
import {
  isWorkbenchTodo,
  selectWorkbenchTodos,
  todoActionFor,
  workbenchStats,
  WORKBENCH_QUICK_LINKS,
  WORKBENCH_TODO_STATUSES,
} from './workbench';

interface MakeOptions {
  id?: number;
  status?: ContractStatus;
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
      propertyName: '測試物件',
      propertyAddress: '台北市測試路 1 號',
      propertyType: '套房',
      propertySize: 10,
      equipment: [],
      rent: 15000,
      deposit: 30000,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      payDay: 5,
      extra: '',
    },
    signature_fields: [],
    dottedsign_task_id: null,
    declined_reason: null,
    created_at: o.created_at ?? '2026-01-01T00:00:00.000Z',
    updated_at: o.updated_at ?? null,
  };
}

describe('待辦的窄規則', () => {
  it('只收待甲方簽與草稿', () => {
    expect([...WORKBENCH_TODO_STATUSES]).toEqual(['awaiting_landlord', 'draft']);
  });

  it('待乙方簽不算待辦：球在租客手上', () => {
    expect(isWorkbenchTodo('awaiting_tenant')).toBe(false);
  });

  it('已拒簽與已撤回不入待辦：那是決定要不要重來，由合約列表承接', () => {
    expect(isWorkbenchTodo('declined')).toBe(false);
    expect(isWorkbenchTodo('voided')).toBe(false);
  });

  it('已完成不入待辦', () => {
    expect(isWorkbenchTodo('completed')).toBe(false);
  });

  it('六個狀態中只有兩個算待辦', () => {
    expect(CONTRACT_STATUSES.filter(isWorkbenchTodo)).toEqual(['draft', 'awaiting_landlord']);
  });
});

describe('selectWorkbenchTodos', () => {
  it('濾掉非待辦狀態', () => {
    const items = CONTRACT_STATUSES.map((status, i) => makeContract({ id: i + 1, status }));
    expect(selectWorkbenchTodos(items).map((c) => c.status).sort()).toEqual([
      'awaiting_landlord',
      'draft',
    ]);
  });

  it('依最後動作時間新到舊排序', () => {
    const items = [
      makeContract({ id: 1, status: 'draft', created_at: '2026-01-01T00:00:00.000Z' }),
      makeContract({ id: 2, status: 'awaiting_landlord', created_at: '2026-03-01T00:00:00.000Z' }),
      makeContract({ id: 3, status: 'draft', created_at: '2026-02-01T00:00:00.000Z' }),
    ];
    expect(selectWorkbenchTodos(items).map((c) => c.id)).toEqual([2, 3, 1]);
  });

  it('有更新時間就用更新時間，不用建立時間', () => {
    const items = [
      makeContract({
        id: 1,
        status: 'draft',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-05-01T00:00:00.000Z',
      }),
      makeContract({ id: 2, status: 'awaiting_landlord', created_at: '2026-03-01T00:00:00.000Z' }),
    ];
    expect(selectWorkbenchTodos(items).map((c) => c.id)).toEqual([1, 2]);
  });

  it('狀態不影響排序：時間新的排前面', () => {
    const items = [
      makeContract({ id: 1, status: 'awaiting_landlord', created_at: '2026-01-01T00:00:00.000Z' }),
      makeContract({ id: 2, status: 'draft', created_at: '2026-02-01T00:00:00.000Z' }),
    ];
    expect(selectWorkbenchTodos(items).map((c) => c.id)).toEqual([2, 1]);
  });

  it('時間相同時以 id 新到舊收尾，排序穩定', () => {
    const items = [
      makeContract({ id: 5, status: 'draft', created_at: '2026-01-01T00:00:00.000Z' }),
      makeContract({ id: 9, status: 'draft', created_at: '2026-01-01T00:00:00.000Z' }),
    ];
    expect(selectWorkbenchTodos(items).map((c) => c.id)).toEqual([9, 5]);
  });

  it('不改動傳入的陣列', () => {
    const items = [
      makeContract({ id: 1, status: 'draft', created_at: '2026-01-01T00:00:00.000Z' }),
      makeContract({ id: 2, status: 'draft', created_at: '2026-02-01T00:00:00.000Z' }),
    ];
    selectWorkbenchTodos(items);
    expect(items.map((c) => c.id)).toEqual([1, 2]);
  });

  it('沒有待辦時回空陣列', () => {
    expect(selectWorkbenchTodos([makeContract({ status: 'completed' })])).toEqual([]);
  });
});

describe('todoActionFor', () => {
  it('待甲方簽的行動是去簽署，連到合約詳情頁', () => {
    expect(todoActionFor(makeContract({ id: 42, status: 'awaiting_landlord' }))).toEqual({
      label: '去簽署',
      href: '/contracts/42',
    });
  });

  it('草稿的行動是繼續編輯，連到建約 wizard', () => {
    expect(todoActionFor(makeContract({ id: 7, status: 'draft' }))).toEqual({
      label: '繼續編輯',
      href: '/contracts/7/edit',
    });
  });

  it('非待辦狀態沒有行動', () => {
    for (const status of ['awaiting_tenant', 'completed', 'declined', 'voided'] as const) {
      expect(todoActionFor(makeContract({ status }))).toBeNull();
    }
  });
});

describe('workbenchStats（核心數據 4 卡）', () => {
  const items = [
    makeContract({ id: 1, status: 'draft' }),
    makeContract({ id: 2, status: 'draft' }),
    makeContract({ id: 3, status: 'awaiting_tenant' }),
    makeContract({ id: 4, status: 'awaiting_landlord' }),
    makeContract({ id: 5, status: 'completed' }),
    makeContract({ id: 6, status: 'declined' }),
    makeContract({ id: 7, status: 'voided' }),
  ];

  it('四張卡的順序是物件、簽署中、待我處理、已完成', () => {
    expect(workbenchStats(items, 3).map((s) => s.key)).toEqual([
      'properties',
      'signing',
      'todo',
      'completed',
    ]);
  });

  it('物件卡用物件數，連到物件頁', () => {
    const [properties] = workbenchStats(items, 3);
    expect(properties.value).toBe(3);
    expect(properties.href).toBe('/properties');
  });

  it('簽署中＝待乙方簽＋待甲方簽', () => {
    expect(workbenchStats(items, 0)[1].value).toBe(2);
  });

  it('待我處理＝待甲方簽＋草稿，與待辦筆數一致', () => {
    expect(workbenchStats(items, 0)[2].value).toBe(3);
    expect(workbenchStats(items, 0)[2].value).toBe(selectWorkbenchTodos(items).length);
  });

  it('已完成只算完成的合約', () => {
    expect(workbenchStats(items, 0)[3].value).toBe(1);
  });

  it('合約相關的三張卡都連到合約頁', () => {
    expect(workbenchStats(items, 0).slice(1).map((s) => s.href)).toEqual([
      '/contracts',
      '/contracts',
      '/contracts',
    ]);
  });

  it('沒有資料時四張卡都是 0', () => {
    expect(workbenchStats([], 0).map((s) => s.value)).toEqual([0, 0, 0, 0]);
  });
});

describe('快捷入口', () => {
  it('三項：建立合約（primary）、查看全部合約、管理物件', () => {
    expect([...WORKBENCH_QUICK_LINKS]).toEqual([
      { key: 'create', label: '建立合約', href: '/contracts/new', primary: true },
      { key: 'contracts', label: '查看全部合約', href: '/contracts', primary: false },
      { key: 'properties', label: '管理物件', href: '/properties', primary: false },
    ]);
  });

  it('建立合約走與側邊 CTA 相同的 wizard 入口', () => {
    expect(WORKBENCH_QUICK_LINKS[0].href).toBe(CREATE_CONTRACT_HREF);
  });
});

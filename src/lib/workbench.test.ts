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
} from './workbench';
import type { SigningProgressById, SigningProgressInput } from './signing-steps';

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
    contract_type: 'lease',
    derived_from: null,
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
      equipmentAnnex: [],
      rent: 15000,
      deposit: 30000,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      payDay: 5,
      extra: '',
    },
    signature_fields: [],
    declined_reason: null,
    created_at: o.created_at ?? '2026-01-01T00:00:00.000Z',
    updated_at: o.updated_at ?? null,
  };
}

// 簽署進度：依序給角色與狀態，兼任的角色放第三個元素
function signing(
  signers: Array<['party_a' | 'party_b' | 'practitioner', 'signed' | 'pending', ('party_a' | 'party_b')[]?]>
): SigningProgressInput {
  return {
    status: 'in_progress',
    signers: signers.map(([role, status, concurrentRoles], i) => ({
      role,
      name: `${role}-${i}`,
      status,
      ...(concurrentRoles ? { concurrentRoles } : {}),
    })),
  };
}

describe('待辦的窄規則（MIL-72：依當前簽署人，不依合約狀態）', () => {
  const todo = (status: ContractStatus, progress?: SigningProgressInput | null) =>
    isWorkbenchTodo(makeContract({ status }), progress);

  it('草稿算待辦', () => {
    expect(todo('draft')).toBe(true);
  });

  it('輪到甲方簽算待辦', () => {
    expect(todo('awaiting_landlord', signing([['party_b', 'signed'], ['party_a', 'pending']]))).toBe(true);
  });

  it('待乙方簽不算待辦：球在承租人手上', () => {
    expect(todo('awaiting_tenant', signing([['party_b', 'pending'], ['party_a', 'pending']]))).toBe(false);
  });

  it('輪到執業人員簽不算待辦：球在執業人員手上', () => {
    const progress = signing([['party_b', 'signed'], ['practitioner', 'pending'], ['party_a', 'pending']]);
    expect(todo('awaiting_practitioner', progress)).toBe(false);
  });

  it('輪到經紀人簽不算待辦，即使甲方已經簽完', () => {
    const progress = signing([
      ['party_b', 'signed'],
      ['practitioner', 'signed'],
      ['party_a', 'signed'],
      ['practitioner', 'pending'],
    ]);
    expect(todo('awaiting_practitioner', progress)).toBe(false);
  });

  it('甲方先簽的序列：甲方簽完後輪到執業人員，就不再是待辦', () => {
    const start = signing([['party_a', 'pending'], ['practitioner', 'pending'], ['party_b', 'pending']]);
    expect(todo('awaiting_landlord', start)).toBe(true);
    const next = signing([['party_a', 'signed'], ['practitioner', 'pending'], ['party_b', 'pending']]);
    expect(todo('awaiting_practitioner', next)).toBe(false);
  });

  it('兼任甲方的簽署人輪到時算待辦：合併不改變輪到誰', () => {
    expect(todo('awaiting_practitioner', signing([['party_b', 'signed'], ['practitioner', 'pending', ['party_a']]]))).toBe(true);
  });

  it('沒有簽署任務的舊合約依合約狀態', () => {
    expect(todo('awaiting_landlord')).toBe(true);
    expect(todo('awaiting_tenant')).toBe(false);
    expect(todo('awaiting_practitioner')).toBe(false);
  });

  it('已拒簽與已撤回不入待辦：那是決定要不要重來，由合約列表承接', () => {
    expect(todo('declined')).toBe(false);
    expect(todo('voided')).toBe(false);
  });

  it('已完成不入待辦', () => {
    expect(todo('completed')).toBe(false);
  });

  it('沒有簽署進度時，七個狀態中只有兩個算待辦', () => {
    expect(CONTRACT_STATUSES.filter((status) => todo(status))).toEqual(['draft', 'awaiting_landlord']);
  });
});

describe('依簽署進度挑待辦與計數', () => {
  const merged = makeContract({ id: 1, status: 'awaiting_practitioner' });
  const practitionerTurn = makeContract({ id: 2, status: 'awaiting_practitioner' });
  const progress: SigningProgressById = {
    '1': signing([['party_b', 'signed'], ['practitioner', 'pending', ['party_a']]]),
    '2': signing([['party_b', 'signed'], ['practitioner', 'pending'], ['party_a', 'pending']]),
  };

  it('三位簽署人輪到執業人員時不進待辦，兼任甲方時進待辦', () => {
    expect(selectWorkbenchTodos([merged, practitionerTurn], progress).map((c) => c.id)).toEqual([1]);
  });

  it('待我處理與待辦筆數一致，簽署中兩份都算', () => {
    const stats = workbenchStats([merged, practitionerTurn], 0, progress);
    expect(stats[1].value).toBe(2);
    expect(stats[2].value).toBe(1);
  });

  it('行動依當前簽署人：輪到甲方的合約是去簽署，輪到執業人員的沒有行動', () => {
    expect(todoActionFor(merged, progress['1'])).toEqual({ label: '去簽署', href: '/contracts/1' });
    expect(todoActionFor(practitionerTurn, progress['2'])).toBeNull();
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

  it('簽署中也算待執業人員簽的合約', () => {
    const withPractitioner = [...items, makeContract({ id: 8, status: 'awaiting_practitioner' })];
    expect(workbenchStats(withPractitioner, 0)[1].value).toBe(3);
    expect(workbenchStats(withPractitioner, 0)[2].value).toBe(3);
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

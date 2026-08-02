// 工作台（登入後預設落地頁）的挑選與計數邏輯，全部是純函式（見 docs/rental-contract-signing-spec.md §5）。
// 頁面只負責取資料與畫畫面，什麼進待辦、怎麼排、卡片算什麼數字都集中在這裡以便測試。

import type { Contract, ContractStatus } from './types';
import { lastActionAt } from './contract-list';
import { CREATE_CONTRACT_HREF } from './nav';

// 待辦的窄規則：只收「等房東動作、流程才會前進」的合約。
// 待乙方簽的球在租客手上；已拒簽／已撤回是「決定要不要重來」，由合約列表承接，工作台不重複。
export const WORKBENCH_TODO_STATUSES = ['awaiting_landlord', 'draft'] as const;
export type WorkbenchTodoStatus = (typeof WORKBENCH_TODO_STATUSES)[number];

export function isWorkbenchTodo(status: ContractStatus): status is WorkbenchTodoStatus {
  return (WORKBENCH_TODO_STATUSES as readonly ContractStatus[]).includes(status);
}

// 依最後動作時間新到舊；時間相同時以 id 新到舊收尾，避免排序不穩定。
export function selectWorkbenchTodos(items: Contract[]): Contract[] {
  return items
    .filter((c) => isWorkbenchTodo(c.status))
    .sort((a, b) => lastActionAt(b).localeCompare(lastActionAt(a)) || b.id - a.id);
}

/** 待辦列的行動：一個狀態一個明確動作，非待辦狀態沒有行動。 */
export interface WorkbenchTodoAction {
  label: string;
  href: string;
}

export function todoActionFor(contract: Contract): WorkbenchTodoAction | null {
  switch (contract.status) {
    case 'awaiting_landlord':
      // 乙方已簽，甲方在詳情頁取簽署連結完成簽署
      return { label: '去簽署', href: `/contracts/${contract.id}` };
    case 'draft':
      // 草稿的編輯體驗一律在 wizard 內（規格 §7）
      return { label: '繼續編輯', href: `/contracts/${contract.id}/edit` };
    default:
      return null;
  }
}

/** 核心數據 4 卡：卡片可點，連到對應頁面。 */
export type WorkbenchStatKey = 'properties' | 'signing' | 'todo' | 'completed';

export interface WorkbenchStat {
  key: WorkbenchStatKey;
  title: string;
  value: number;
  href: string;
}

export function workbenchStats(contracts: Contract[], propertyCount: number): WorkbenchStat[] {
  const count = (predicate: (status: ContractStatus) => boolean) =>
    contracts.filter((c) => predicate(c.status)).length;

  return [
    { key: 'properties', title: '物件', value: propertyCount, href: '/properties' },
    {
      key: 'signing',
      title: '簽署中',
      value: count((s) => s === 'awaiting_tenant' || s === 'awaiting_landlord'),
      href: '/contracts',
    },
    // 待我處理＝待辦筆數（待甲方簽＋草稿）
    { key: 'todo', title: '待我處理', value: count(isWorkbenchTodo), href: '/contracts' },
    { key: 'completed', title: '已完成', value: count((s) => s === 'completed'), href: '/contracts' },
  ];
}

/** 快捷入口三項；建立合約走與側邊常駐 CTA 相同的 wizard 入口。 */
export interface WorkbenchQuickLink {
  key: 'create' | 'contracts' | 'properties';
  label: string;
  href: string;
  primary: boolean;
}

export const WORKBENCH_QUICK_LINKS: readonly WorkbenchQuickLink[] = [
  { key: 'create', label: '建立合約', href: CREATE_CONTRACT_HREF, primary: true },
  { key: 'contracts', label: '查看全部合約', href: '/contracts', primary: false },
  { key: 'properties', label: '管理物件', href: '/properties', primary: false },
];

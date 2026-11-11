// 工作台（登入後預設落地頁）的挑選與計數邏輯，全部是純函式（見 docs/rental-contract-signing-spec.md §5）。
// 頁面只負責取資料與畫畫面，什麼進待辦、怎麼排、卡片算什麼數字都集中在這裡以便測試。

import { isPartyATurn, type SigningProgressById, type SigningProgressInput } from './signing-steps';
import type { Contract } from './types';
import { isSigningStatus } from './types';
import { lastActionAt } from './contract-list';
import { CREATE_CONTRACT_HREF } from './nav';

// 待辦的窄規則：只收「球在出租人手上」的合約，也就是草稿，與輪到甲方簽的合約。
// 輪到誰依簽署序列的當前簽署人判斷，不依合約狀態（MIL-72，重看 MIL-59）：
// 輪到乙方、執業人員或經紀人時，球不在甲方手上。兼任甲方的簽署人輪到時算甲方，合併不改變輪到誰。
// 已拒簽／已撤回是「決定要不要重來」，由合約列表承接，工作台不重複。

export function isWorkbenchTodo(contract: Pick<Contract, 'status'>, progress?: SigningProgressInput | null): boolean {
  return contract.status === 'draft' || isPartyATurn(contract.status, progress);
}

// 依最後動作時間新到舊；時間相同時以 id 新到舊收尾，避免排序不穩定。
export function selectWorkbenchTodos(items: Contract[], progress: SigningProgressById = {}): Contract[] {
  return items
    .filter((c) => isWorkbenchTodo(c, progress[String(c.id)]))
    .sort((a, b) => lastActionAt(b).localeCompare(lastActionAt(a)) || b.id.localeCompare(a.id));
}

/** 待辦列的行動：一個狀態一個明確動作，非待辦的合約沒有行動。 */
export interface WorkbenchTodoAction {
  label: string;
  href: string;
}

export function todoActionFor(contract: Contract, progress?: SigningProgressInput | null): WorkbenchTodoAction | null {
  if (contract.status === 'draft') {
    // 草稿的編輯體驗一律在 wizard 內（規格 §7）
    return { label: '繼續編輯', href: `/contracts/${contract.id}/edit` };
  }
  // 甲方輪到簽署，在詳情頁取簽署連結完成簽署
  return isPartyATurn(contract.status, progress) ? { label: '去簽署', href: `/contracts/${contract.id}` } : null;
}

/** 核心數據 4 卡：卡片可點，連到對應頁面。 */
export type WorkbenchStatKey = 'properties' | 'signing' | 'todo' | 'completed';

export interface WorkbenchStat {
  key: WorkbenchStatKey;
  title: string;
  value: number;
  href: string;
}

export function workbenchStats(
  contracts: Contract[],
  propertyCount: number | null,
  progress: SigningProgressById = {}
): WorkbenchStat[] {
  const count = (predicate: (contract: Contract) => boolean) => contracts.filter(predicate).length;

  // 沒有物件讀取權限時（propertyCount 為 null）不顯示物件數字，避免把「看不到」顯示成 0
  const propertyStat: WorkbenchStat[] =
    propertyCount === null ? [] : [{ key: 'properties', title: '物件', value: propertyCount, href: '/properties' }];

  return [
    ...propertyStat,
    {
      key: 'signing',
      title: '簽署中',
      value: count((c) => isSigningStatus(c.status)),
      href: '/contracts',
    },
    // 待我處理＝待辦筆數（輪到甲方簽＋草稿）
    { key: 'todo', title: '待我處理', value: count((c) => isWorkbenchTodo(c, progress[String(c.id)])), href: '/contracts' },
    { key: 'completed', title: '已完成', value: count((c) => c.status === 'completed'), href: '/contracts' },
  ];
}

/** 快捷入口三項；建立合約走與側邊常駐 CTA 相同的入口：物件列表（MIL-209）。 */
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

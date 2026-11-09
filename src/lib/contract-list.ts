// 合約列表的篩選、排序與進度計算，全部是純函式（見 docs/rental-contract-signing-spec.md §6）。
// UI 只負責蒐集條件與畫畫面，判斷邏輯集中在這裡以便測試。

import { DEFAULT_CONTRACT_TYPE, contractTypeDefinition, listSummaryOf } from './contract-types';
import { TERMS } from './labels';
import { evaluateRouting } from './signature-routing';
import {
  buildSigningSteps,
  signingStepDots,
  type SigningMerge,
  type SigningProgressInput,
  type SigningStepDot,
  type SigningSteps,
} from './signing-steps';
import type { Contract, ContractStatus } from './types';
import { CONTRACT_STATUSES } from './types';

// 最後動作時間：更新時間為主，沒有則用建立時間。
export function lastActionAt(contract: Contract): string {
  return contract.updated_at ?? contract.created_at;
}

export function countByStatus(items: Contract[]): Record<ContractStatus, number> {
  const counts = Object.fromEntries(CONTRACT_STATUSES.map((s) => [s, 0])) as Record<ContractStatus, number>;
  for (const c of items) counts[c.status] += 1;
  return counts;
}

// 清單的狀態分頁。畫面還無法建立三位簽署人的合約，所以待執業人員簽的分頁
// 只在有這種合約、或正在看這個分頁時出現，兩方合約的分頁維持原樣。
export function statusTabs(counts: Record<ContractStatus, number>, selected: ContractStatus | 'all'): ContractStatus[] {
  return CONTRACT_STATUSES.filter(
    (s) => s !== 'awaiting_practitioner' || counts[s] > 0 || selected === s
  );
}

// 物件下拉的選項來源：合約帶入的物件名稱快照，去重後排序。
export function propertyNameOptions(items: Contract[]): string[] {
  const names = new Set<string>();
  for (const c of items) {
    const name = listSummaryOf(c).propertyName;
    if (name) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
}

/** 租期涵蓋區間（YYYY-MM-DD 起迄），與合約租期重疊即命中。 */
export type LeaseRange = [string, string];

export interface ContractListFilter {
  status: ContractStatus | 'all';
  propertyName: string | null;
  leaseRange: LeaseRange | null;
}

export const EMPTY_CONTRACT_LIST_FILTER: ContractListFilter = {
  status: 'all',
  propertyName: null,
  leaseRange: null,
};

// 區間重疊判定。日期是 YYYY-MM-DD，字串比較即等於時間比較。
// 租期未填的合約無從判斷涵蓋，指定區間時一律不命中。
export function overlapsLeaseRange(contract: Contract, range: LeaseRange | null): boolean {
  if (!range) return true;
  const period = listSummaryOf(contract).period;
  if (!period) return false;
  const [startDate, endDate] = period;
  const [from, to] = range;
  return endDate >= from && startDate <= to;
}

export function matchesFilter(contract: Contract, filter: ContractListFilter): boolean {
  if (filter.status !== 'all' && contract.status !== filter.status) return false;
  if (filter.propertyName && listSummaryOf(contract).propertyName !== filter.propertyName) return false;
  return overlapsLeaseRange(contract, filter.leaseRange);
}

const EMPTY_CELL = '—';

/**
 * 清單「乙方」欄的欄名與儲存格（MIL-122、MIL-73）。稱謂依合約類型從標籤對照表取：
 * 清單全是同一種類型（或空的）時，欄名用那個類型的稱謂，儲存格只有姓名；
 * 兩種類型混在一起時欄名只有「乙方」，儲存格補上各自的稱謂，才分得出誰是承租人、誰是受託人。
 */
export function listPartyBColumn(contracts: readonly Contract[]): { title: string; cell: (contract: Contract) => string } {
  const types = new Set(contracts.map((c) => c.contract_type));
  if (types.size > 1) {
    return {
      title: TERMS.partyB,
      cell: (c) => {
        const name = listSummaryOf(c).partyB.name;
        return name ? `${name}（${contractTypeDefinition(c.contract_type).labels.partyB}）` : EMPTY_CELL;
      },
    };
  }
  const type = contracts.length > 0 ? contracts[0].contract_type : DEFAULT_CONTRACT_TYPE;
  return {
    title: contractTypeDefinition(type).labels.partyBFull,
    cell: (c) => listSummaryOf(c).partyB.name || EMPTY_CELL,
  };
}

export function listPropertyLabel(contract: Contract): string {
  return listSummaryOf(contract).propertyName || EMPTY_CELL;
}

export function listRentLabel(contract: Contract): string {
  const { rent } = listSummaryOf(contract);
  return rent != null ? `$${rent.toLocaleString()}` : EMPTY_CELL;
}

export function listPeriodLabel(contract: Contract): string {
  const { period } = listSummaryOf(contract);
  return period ? `${period[0]} ~ ${period[1]}` : EMPTY_CELL;
}

// 進行中優先：簽署中 → 草稿 → 拒簽／撤回 → 已完成。
const WORK_PRIORITY: Record<ContractStatus, number> = {
  awaiting_tenant: 0,
  awaiting_landlord: 0,
  awaiting_practitioner: 0,
  draft: 1,
  declined: 2,
  voided: 2,
  completed: 3,
};

// 同組內依最後動作時間新到舊；時間相同時以 id 新到舊收尾，避免排序不穩定。
export function compareByWorkPriority(a: Contract, b: Contract): number {
  return (
    WORK_PRIORITY[a.status] - WORK_PRIORITY[b.status] ||
    lastActionAt(b).localeCompare(lastActionAt(a)) ||
    b.id - a.id
  );
}

export function selectContracts(items: Contract[], filter: ContractListFilter): Contract[] {
  return items.filter((c) => matchesFilter(c, filter)).sort(compareByWorkPriority);
}

/**
 * 合約的簽署進度步驟與目前位置（MIL-72）。簽署序列由規則表依合約的分流條件算出，沒有簽署任務時（草稿、舊合約）
 * 步驟就用它，有簽署任務時只取稱謂，步驟取自實際的簽署人。規則表沒有定義的組合退回兩方，畫面不報錯。
 * 清單、工作台、詳情頁與確認頁共用，F 線的資產總覽也能直接呼叫。
 */
export function contractSigningSteps(
  contract: Pick<Contract, 'status' | 'fields' | 'contract_type'>,
  progress?: SigningProgressInput | null,
  merges?: readonly SigningMerge[]
): SigningSteps {
  const evaluation = evaluateRouting(contract.fields.routing, contract.contract_type);
  return buildSigningSteps({
    status: contract.status,
    progress,
    seats: evaluation.ok ? evaluation.seats : null,
    merges,
    contractType: contract.contract_type,
  });
}

/** 清單的簽署進度點。不在簽署流程（草稿、已拒簽、已撤回）回 null，畫面顯示「—」。 */
export function listSigningDots(contract: Contract, progress?: SigningProgressInput | null): SigningStepDot[] | null {
  return signingStepDots(contractSigningSteps(contract, progress));
}

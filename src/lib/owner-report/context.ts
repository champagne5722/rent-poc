// 建報表前先把輸入收斂成這個月、這位屋主、這個產出組織的範圍，並檢查輸入。
// 之後各區段只讀 context，不再碰範圍外的資料。純函式，不讀系統時鐘。

import { accountTotals, isReversal, naturalBalance, type Journal } from '../ledger';
import { toTaipeiDate } from '../receivables';
import { assertDate, monthBounds, type MonthBounds } from './dates';
import type { OwnerReportInput, OwnerReportOptions, ReportPaymentAccount, ReportUnit } from './types';

export interface ReportContext {
  bounds: MonthBounds;
  options: OwnerReportOptions;
  input: OwnerReportInput;
  /** 屋主乘產出組織範圍內的單位，保持輸入順序。 */
  units: ReportUnit[];
  unitByCase: Map<string, ReportUnit>;
  /** 範圍內、月底前（含）的分錄，依登錄時間排序。 */
  journals: Journal[];
  journalsByCase: Map<string, Journal[]>;
  journalById: Map<string, Journal>;
  accounts: Map<string, ReportPaymentAccount>;
  postedDate(journal: Journal): string;
  /** 沖銷分錄的原分錄。原分錄不在範圍內時丟 RangeError。 */
  originalOf(journal: Journal): Journal;
  /** 該案件在月底的科目自然方向餘額。 */
  balanceOf(caseId: string, account: string): number;
  isInMonth(journal: Journal): boolean;
}

export function assertMoney(value: number, name: string, options: { allowNegative?: boolean } = {}): void {
  if (!Number.isSafeInteger(value) || (!options.allowNegative && value < 0)) {
    throw new RangeError(`${name}必須是${options.allowNegative ? '' : ' 0 以上的'}安全整數元：${value}`);
  }
}

function checkInput(input: OwnerReportInput, options: OwnerReportOptions): void {
  if (!Number.isInteger(options.graceDays) || options.graceDays < 0) {
    throw new RangeError(`寬限天數必須是 0 以上的整數：${options.graceDays}`);
  }
  for (const p of input.periods) {
    assertMoney(p.amount, `期別 ${p.id} 的應收金額`);
    assertDate(p.dueDate, `期別 ${p.id} 的到期日`);
  }
  for (const a of input.allocations) {
    assertMoney(a.amount, `配置 ${a.id} 的金額`);
    if (a.active && a.deactivatedAt !== null) {
      throw new RangeError(`配置 ${a.id} 仍有效，不得有失效時間`);
    }
  }
  for (const d of input.depositLedgers) assertMoney(d.expectedAmount, `案件 ${d.caseId} 的約定押金`);
  for (const h of input.handovers) {
    assertMoney(h.amount, `代收 ${h.handoverId} 的金額`);
    assertDate(h.receivedAt, `代收 ${h.handoverId} 的代收日`);
    if (h.handedOverAt !== null) {
      assertDate(h.handedOverAt, `代收 ${h.handoverId} 的交付日`);
      if (h.handedOverAmount === null) throw new RangeError(`代收 ${h.handoverId} 有交付日，必須有交付金額`);
    }
    if (h.handedOverAmount !== null) assertMoney(h.handedOverAmount, `代收 ${h.handoverId} 的交付金額`);
  }
  for (const r of input.repairs) {
    assertDate(r.reportedAt, `修繕 ${r.repairId} 的報修日`);
    if (r.closedAt !== null) assertDate(r.closedAt, `修繕 ${r.repairId} 的結案日`);
    if (r.cost !== null) assertMoney(r.cost, `修繕 ${r.repairId} 的費用`);
  }
}

export function createContext(input: OwnerReportInput, month: string, options: OwnerReportOptions): ReportContext {
  const bounds = monthBounds(month);
  checkInput(input, options);

  const units = input.units.filter((u) => u.ownerId === options.ownerId && u.orgId === options.orgId);
  const unitByCase = new Map<string, ReportUnit>();
  for (const unit of units) {
    if (unitByCase.has(unit.caseId)) throw new RangeError(`案件 ${unit.caseId} 出現在多個租賃單位`);
    unitByCase.set(unit.caseId, unit);
  }

  const postedDate = (journal: Journal) => toTaipeiDate(journal.postedAt);
  const journals = input.journals
    .filter((j) => j.orgId === options.orgId && unitByCase.has(j.caseId) && postedDate(j) <= bounds.end)
    .sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt) || (a.journalId < b.journalId ? -1 : 1));

  const journalById = new Map<string, Journal>();
  const journalsByCase = new Map<string, Journal[]>();
  for (const journal of journals) {
    if (journalById.has(journal.journalId)) throw new RangeError(`分錄 ID 重複：${journal.journalId}`);
    journalById.set(journal.journalId, journal);
    const list = journalsByCase.get(journal.caseId) ?? [];
    list.push(journal);
    journalsByCase.set(journal.caseId, list);
  }

  const accounts = new Map(input.paymentAccounts.map((a) => [a.paymentAccountId, a] as const));

  return {
    bounds,
    options,
    input,
    units,
    unitByCase,
    journals,
    journalsByCase,
    journalById,
    accounts,
    postedDate,
    originalOf(journal) {
      if (!isReversal(journal)) throw new RangeError(`分錄 ${journal.journalId} 不是沖銷分錄`);
      const original = journalById.get(journal.reversesJournalId);
      if (!original) throw new RangeError(`沖銷分錄 ${journal.journalId} 的原分錄 ${journal.reversesJournalId} 不在輸入內`);
      return original;
    },
    balanceOf(caseId, account) {
      const totals = accountTotals(journalsByCase.get(caseId) ?? []).get(account);
      return totals ? naturalBalance(account, totals) : 0;
    },
    isInMonth(journal) {
      const date = postedDate(journal);
      return date >= bounds.start && date <= bounds.end;
    },
  };
}

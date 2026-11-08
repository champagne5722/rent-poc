// 對帳檔一列的自動配對（ADR-0050 決議 6、ADR-0014 決議 8）。純函式：事實由呼叫端查好後傳入。

import { diffDays } from './dates';
import type {
  CaseFacts,
  HolderRuleAction,
  MatchFacts,
  MatchResult,
  RemitterIdentifier,
  RentalPurpose,
  StatementRow,
  UnmatchedReason,
} from './types';
import { assertIsoDate, assertNonNegativeAmount, assertPositiveAmount, assertValidRow } from './validate';

/** 跨來源重複的入帳日差距，單位是天。3 天是假設值，待訪談驗證（ADR-0014 決議 8）。 */
export const CROSS_SOURCE_DUPLICATE_WINDOW_DAYS = 3;

export interface MatchOptions {
  /** 覆寫跨來源重複的天數視窗，含邊界。預設 3。 */
  duplicateWindowDays?: number;
}

function normalizeName(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/** 去掉空白與連字號後的最後五個字元，必須全是數字。遮罩在尾端的帳號（12345***）不命中。 */
function lastFiveDigits(account: string): string | null {
  const tail = account.normalize('NFKC').replace(/[\s-]/g, '').slice(-5);
  return /^\d{5}$/.test(tail) ? tail : null;
}

function assertIdentifier(identifier: RemitterIdentifier): void {
  if (identifier.kind === 'account_last5') {
    if (!/^\d{5}$/.test(identifier.value)) throw new RangeError(`帳號末五碼必須是五位數字：${identifier.value}`);
  } else if (normalizeName(identifier.value) === '') {
    throw new RangeError('匯款識別的戶名必須非空');
  }
}

function identifierHits(identifier: RemitterIdentifier, row: StatementRow): boolean {
  if (identifier.kind === 'name') {
    const name = normalizeName(row.counterpartyName);
    return name !== '' && name === normalizeName(identifier.value);
  }
  return lastFiveDigits(row.counterpartyAccount) === identifier.value;
}

/** 押金未收足且金額等於差額是押金，押金已收足是租金，其餘無法判定。 */
function determinePurpose(amount: number, expected: number, received: number): RentalPurpose | null {
  if (received >= expected) return 'rent';
  return amount === expected - received ? 'security_deposit' : null;
}

function assertMatchInput(row: StatementRow, facts: MatchFacts, windowDays: number): void {
  assertValidRow(row);
  if (!Number.isSafeInteger(windowDays) || windowDays < 0) throw new RangeError(`重複視窗必須是非負整數天：${windowDays}`);
  for (const c of facts.cases) {
    c.remitterIdentifiers.forEach(assertIdentifier);
    if (c.contractCompleted) {
      assertNonNegativeAmount(c.deposit.expectedAmount, '約定押金');
      assertNonNegativeAmount(c.deposit.receivedAmount, '已收押金');
    }
  }
  for (const m of facts.manualReceipts) {
    assertPositiveAmount(m.amount, '手動入帳確認的金額');
    assertIsoDate(m.valueDate, '手動入帳確認的入帳日');
  }
}

/**
 * 六個條件全部成立才回傳案件與用途，否則回傳進待配對清單的原因（ADR-0050 決議 6）。
 *
 * 條件：收款帳戶相同、匯款識別命中恰好一個案件、用途能判定、押金帳戶規則不是 block、
 * 沒有跨來源重複、合約已完成。另外，現金收取帳戶不參與對帳檔比對，直接回傳 cash_account。
 *
 * 失敗時 `reasons` 列出所有「能判斷且不成立」的條件，`reason` 是第一個。順序是：匯款識別、帳戶、
 * 用途、規則、跨來源重複、合約。帳戶要先有命中的案件才能判斷，所以匯款識別排在前面。
 * 沒有命中案件時，帳戶、用途、規則、合約都無從判斷。合約未完成時沒有押金台帳，用途與規則無從判斷。
 * 輸入資料不合法時丟 RangeError。
 */
export function matchStatementRow(row: StatementRow, facts: MatchFacts, options: MatchOptions = {}): MatchResult {
  const windowDays = options.duplicateWindowDays ?? CROSS_SOURCE_DUPLICATE_WINDOW_DAYS;
  assertMatchInput(row, facts, windowDays);

  if (facts.importAccount.kind === 'cash') {
    return { ok: false, reason: 'cash_account', reasons: ['cash_account'] };
  }

  const reasons: UnmatchedReason[] = [];
  const hits = facts.cases.filter((c) => c.remitterIdentifiers.some((id) => identifierHits(id, row)));
  let matched: CaseFacts | null = null;
  let ambiguousCaseIds: string[] | undefined;
  if (hits.length === 0) reasons.push('no_remitter_match');
  else if (hits.length > 1) {
    reasons.push('ambiguous_remitter');
    ambiguousCaseIds = hits.map((c) => c.caseId);
  } else matched = hits[0];

  let purpose: RentalPurpose | null = null;
  let holderRuleAction: HolderRuleAction = 'allow';
  if (matched) {
    if (!matched.paymentAccountIds.includes(facts.importAccount.id)) reasons.push('payment_account_mismatch');
    if (matched.contractCompleted) {
      purpose = determinePurpose(row.depositAmount, matched.deposit.expectedAmount, matched.deposit.receivedAmount);
      if (purpose === null) reasons.push('purpose_undeterminable');
      else if (purpose === 'security_deposit') {
        holderRuleAction = matched.depositHolderRuleAction;
        if (holderRuleAction === 'block') reasons.push('deposit_rule_blocked');
      }
    }
  }

  const duplicateCandidateIds = facts.manualReceipts
    .filter(
      (m) =>
        m.paymentAccountId === facts.importAccount.id &&
        m.amount === row.depositAmount &&
        Math.abs(diffDays(row.transactionDate, m.valueDate)) <= windowDays,
    )
    .map((m) => m.id);
  if (duplicateCandidateIds.length > 0) reasons.push('possible_duplicate_manual');

  if (matched && !matched.contractCompleted) reasons.push('contract_incomplete');

  if (reasons.length === 0 && matched && purpose) {
    return { ok: true, caseId: matched.caseId, purpose, holderRuleAction };
  }
  return {
    ok: false,
    reason: reasons[0],
    reasons,
    ...(matched ? { caseId: matched.caseId } : {}),
    ...(duplicateCandidateIds.length > 0 ? { duplicateCandidateIds } : {}),
    ...(ambiguousCaseIds ? { ambiguousCaseIds } : {}),
  };
}

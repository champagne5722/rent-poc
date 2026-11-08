// 科目編碼的產生與解析（ADR-0015 決議 2）。純函式。
// 編碼格式固定三段：`{類型}.{名稱}.{ID}`。收款帳戶用 ID 而不用遮罩識別，因為遮罩識別會撞。

export const ACCOUNT_KINDS = ['asset', 'liability', 'income'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ACCOUNT_PATTERN = /^(asset|liability|income)\.([a-z][a-z_]*)\.([A-Za-z0-9_-]{1,64})$/;

/** ID 只准英數、底線與連字號，長度 1 到 64。ULID 與 UUID 都符合，也保證 ID 不含分隔用的點。 */
export function isValidLedgerId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function checked(id: string, what: string): string {
  if (!isValidLedgerId(id)) {
    throw new RangeError(`${what}不合法：${JSON.stringify(id)}`);
  }
  return id;
}

/** 收款帳戶科目。持有人在帳戶表上，科目只認帳戶 ID。 */
export function bankAccount(paymentAccountId: string): string {
  return `asset.bank.${checked(paymentAccountId, '收款帳戶 ID')}`;
}

export function depositAccount(caseId: string): string {
  return `liability.deposit.${checked(caseId, '案件 ID')}`;
}

export function prepaidRentAccount(caseId: string): string {
  return `liability.prepaid_rent.${checked(caseId, '案件 ID')}`;
}

export function rentIncomeAccount(caseId: string): string {
  return `income.rent.${checked(caseId, '案件 ID')}`;
}

export function deductionIncomeAccount(caseId: string): string {
  return `income.deduction.${checked(caseId, '案件 ID')}`;
}

export interface ParsedAccount {
  kind: AccountKind;
  name: string;
  id: string;
}

/** 不合法的編碼回傳 null。 */
export function parseAccountCode(code: string): ParsedAccount | null {
  const match = typeof code === 'string' ? ACCOUNT_PATTERN.exec(code) : null;
  if (!match) return null;
  return { kind: match[1] as AccountKind, name: match[2], id: match[3] };
}

export interface RawBalance {
  debit: number;
  credit: number;
}

/** 自然方向餘額：資產看借減貸，負債與收入看貸減借。 */
export function naturalBalance(account: string, balance: RawBalance): number {
  const parsed = parseAccountCode(account);
  if (!parsed) throw new RangeError(`科目編碼不合法：${JSON.stringify(account)}`);
  return parsed.kind === 'asset' ? balance.debit - balance.credit : balance.credit - balance.debit;
}

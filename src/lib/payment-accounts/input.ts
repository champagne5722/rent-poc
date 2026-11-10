import { HOLDER_KINDS, type HolderKind } from '../deposit-rules';

// 收款帳戶的請求本文驗證（MIL-118）。純函式，登錄與修改共用同一份規則。
// 持有人的 party（holderPartyId）由請求帶，值來自持有人選單（MIL-187）。沒帶時 lessor、owner、manager
// 取目前登入者，other 沒有 party（見 repository）。這裡只檢查型別，party 是否在選單內由 repository 檢查。

/** 介面上的持有人種類名稱，用 GLOSSARY 的詞。 */
export const HOLDER_KIND_LABELS: Record<HolderKind, string> = {
  lessor: '出租人',
  owner: '屋主',
  manager: '代管業者',
  other: '其他',
};

export const PAYMENT_METHODS = ['bank', 'cash'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const MAX_TEXT_LENGTH = 60;

/** 3 碼銀行代碼，或含分行的 7 碼。畫面與伺服器共用。 */
export const BANK_CODE_PATTERN = /^\d{3}(\d{4})?$/;
/** 帳號末四碼。 */
export const ACCOUNT_LAST4_PATTERN = /^\d{4}$/;

export interface PaymentAccountInput {
  /** 使用者看得懂的名稱。 */
  name: string;
  holderKind: HolderKind;
  /** 持有人姓名或名稱。other 時是持有人本人，其餘是顯示用名稱。 */
  holderName: string;
  /**
   * 持有人的 party，來自持有人選單。請求沒帶時沒有這個欄位。
   * other 沒有 party，帶了也不存。是否為本組織的成員或案件成員，由 repository 檢查。
   */
  holderPartyId?: string;
  method: PaymentMethod;
  /** 3 碼銀行代碼，或 7 碼銀行加分行代碼。現金收取為 null。 */
  bankCode: string | null;
  /** 帳號末四碼。現金收取為 null。 */
  accountLast4: string | null;
}

export type PaymentAccountInputResult = { ok: true; value: PaymentAccountInput } | { ok: false; error: string };

const fail = (error: string): PaymentAccountInputResult => ({ ok: false, error });

function text(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() : null;
}

export function parsePaymentAccountInput(body: unknown): PaymentAccountInputResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail('請求內容格式有誤');
  const raw = body as Record<string, unknown>;

  const name = text(raw.name);
  if (!name) return fail('帳戶名稱為必填');
  if (name.length > MAX_TEXT_LENGTH) return fail(`帳戶名稱不得超過 ${MAX_TEXT_LENGTH} 字`);

  if (!(HOLDER_KINDS as readonly unknown[]).includes(raw.holderKind)) {
    return fail(`持有人種類需為${HOLDER_KINDS.map((k) => HOLDER_KIND_LABELS[k]).join('、')}其中之一`);
  }
  const holderKind = raw.holderKind as HolderKind;

  const holderName = text(raw.holderName);
  if (!holderName) return fail(holderKind === 'other' ? '請填持有人姓名' : '持有人名稱為必填');
  if (holderName.length > MAX_TEXT_LENGTH) return fail(`持有人名稱不得超過 ${MAX_TEXT_LENGTH} 字`);

  // 空值視為沒帶。非字串是客戶端寫錯，回 400。字串的內容（是否存在、屬於誰）留給 repository 回 422
  let party: { holderPartyId: string } | Record<string, never> = {};
  if (raw.holderPartyId != null) {
    if (typeof raw.holderPartyId !== 'string') return fail('持有人格式有誤');
    const trimmed = raw.holderPartyId.trim();
    if (trimmed !== '') party = { holderPartyId: trimmed };
  }

  if (!(PAYMENT_METHODS as readonly unknown[]).includes(raw.method)) return fail('收款方式需為銀行帳戶或現金收取');
  const method = raw.method as PaymentMethod;

  if (method === 'cash') {
    if (raw.bankCode != null && raw.bankCode !== '') return fail('現金收取不填銀行代碼');
    if (raw.accountLast4 != null && raw.accountLast4 !== '') return fail('現金收取不填帳號末四碼');
    return { ok: true, value: { name, holderKind, holderName, ...party, method, bankCode: null, accountLast4: null } };
  }

  const bankCode = text(raw.bankCode);
  if (!bankCode || !BANK_CODE_PATTERN.test(bankCode)) return fail('銀行代碼需為 3 碼，或含分行的 7 碼數字');
  const accountLast4 = text(raw.accountLast4);
  if (!accountLast4 || !ACCOUNT_LAST4_PATTERN.test(accountLast4)) return fail('帳號末四碼需為 4 碼數字，不要填完整帳號');
  return { ok: true, value: { name, holderKind, holderName, ...party, method, bankCode, accountLast4 } };
}

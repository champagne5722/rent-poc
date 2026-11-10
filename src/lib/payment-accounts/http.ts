import { requestContext } from '../current-request-context';
import { jsonError } from '../http';
import { OrgContextRequired, Unauthenticated } from '../request-context';

// 收款帳戶 route 共用的回應對照（MIL-118）。錯誤碼來自 repository，訊息給使用者看，不含「信託」。

export const PAYMENT_ACCOUNT_ERRORS = {
  not_found: { status: 404, message: '收款帳戶不存在' },
  inactive: { status: 409, message: '收款帳戶已停用，不能修改。請新增帳戶' },
  already_inactive: { status: 409, message: '收款帳戶已停用' },
  locked: {
    status: 409,
    message: '這個帳戶已有分錄引用，持有人與銀行帳號末四碼不得修改。請停用並新增',
  },
  method_change: { status: 400, message: '銀行帳戶與現金收取不能互相切換。請停用並新增' },
  cash_exists: { status: 409, message: '這位持有人已有現金收取帳戶' },
  holder_party_required: { status: 400, message: '找不到持有人，請重新登入後再試' },
  // 不存在的 party、別的組織的 party、格式錯誤的 ID 都回這一個，不洩漏它是哪一種
  holder_not_allowed: { status: 422, message: '持有人必須從成員清單中選擇' },
} as const;

export type PaymentAccountErrorCode = keyof typeof PAYMENT_ACCOUNT_ERRORS;

export function paymentAccountError(code: PaymentAccountErrorCode): Response {
  const { status, message } = PAYMENT_ACCOUNT_ERRORS[code];
  return jsonError(status, message);
}

/**
 * 目前登入者的 party，當作出租人、屋主、代管業者持有人的 party。
 * 沒有登入回 401 的 Response，不是組織身分回 403。
 * 持有人改從成員清單選（MIL-187）後，這個函式只剩「請求沒有指定持有人」時的預設值。
 */
export async function currentPartyId(): Promise<{ ok: true; partyId: string } | { ok: false; response: Response }> {
  try {
    const rc = await requestContext();
    if (rc.kind !== 'org') return { ok: false, response: jsonError(403, new OrgContextRequired().message) };
    return { ok: true, partyId: rc.partyId };
  } catch (error) {
    if (error instanceof Unauthenticated) return { ok: false, response: jsonError(401, error.message) };
    throw error;
  }
}

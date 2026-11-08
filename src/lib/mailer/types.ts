// Mailer seam（ADR-0022 決議 3，MIL-103）。寄信的唯一入口，登入驗證碼經它寄出。
//
// 介面的規則：
// - send 成功回傳 { id }，失敗丟例外。呼叫端不得把 send 放進 withTx 的 callback（外部呼叫，ADR-0012 決議 10），
//   要先提交交易再寄。
// - kind 是信件種類，格式 `領域.動作`，例如 `auth.otp`。E 線（MIL-120 起）的 notify() 沿用同一個介面，
//   通知種類各自取 kind，adapter 不依 kind 分支。
// - 目前只有 log 與 Mock 兩個 adapter。真實寄信服務在 pilot 前由使用者選定，是上線閘門。

export interface MailMessage {
  /** 收件人，單一 email。 */
  to: string;
  subject: string;
  /** 純文字本文。 */
  text: string;
  kind: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<{ id: string }>;
}

export const MAIL_KIND_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

/** 所有 adapter 共用的輸入檢查。不合格丟錯，避免兩個 adapter 的行為分岔。 */
export function assertValidMessage(message: MailMessage): void {
  if (!/^[^@\s,;]+@[^@\s,;]+$/.test(message.to)) throw new Error('收件人必須是單一個合法的 email');
  if (message.subject.trim() === '') throw new Error('信件主旨不得為空');
  if (/[\r\n]/.test(message.subject)) throw new Error('信件主旨不得含換行');
  if (message.text.trim() === '') throw new Error('信件本文不得為空');
  if (!MAIL_KIND_PATTERN.test(message.kind)) throw new Error('信件種類格式必須是「領域.動作」');
}

// Mailer seam（ADR-0022 決議 3，MIL-103）。寄信的唯一入口，登入驗證碼經它寄出。
//
// 介面的規則：
// - send 成功回傳 { id }，失敗丟例外。呼叫端不得把 send 放進 withTx 的 callback（外部呼叫，ADR-0012 決議 10），
//   要先提交交易再寄。
// - kind 是信件種類，格式 `領域.動作`，例如 `auth.otp`。E 線（MIL-120 起）的 notify() 沿用同一個介面，
//   通知種類各自取 kind，adapter 不依 kind 分支。
// - from 是寄件名義（顯示名稱，例如「○○管理公司」），由呼叫端傳入。沒有傳時 adapter 用自己的預設寄件人。
//   MIL-120 起 notify() 一律帶 from；登入驗證碼這類平台信可以不帶。
// - listSent() 查寄件紀錄，新的在前。log 與 Mock adapter 留在記憶體（程序重啟就清空），
//   真實寄信服務的 adapter 若查不到紀錄，回傳空陣列，不得丟錯。
// - 目前只有 log 與 Mock 兩個 adapter。真實寄信服務在 pilot 前由使用者選定，是上線閘門。

export interface MailMessage {
  /** 收件人，單一 email。 */
  to: string;
  subject: string;
  /** 純文字本文。 */
  text: string;
  kind: string;
  /** 寄件名義。不得為空、不得含換行、最長 100 字。 */
  from?: string;
}

/** 一封已寄出的信。 */
export interface SentMail extends MailMessage {
  id: string;
  sentAt: Date;
}

export interface Mailer {
  send(message: MailMessage): Promise<{ id: string }>;
  /** 寄件紀錄，新的在前。回傳複本。 */
  listSent(): Promise<readonly SentMail[]>;
}

export const MAIL_FROM_MAX_LENGTH = 100;

export const MAIL_KIND_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

/** 所有 adapter 共用的輸入檢查。不合格丟錯，避免兩個 adapter 的行為分岔。 */
export function assertValidMessage(message: MailMessage): void {
  if (!/^[^@\s,;]+@[^@\s,;]+$/.test(message.to)) throw new Error('收件人必須是單一個合法的 email');
  if (message.subject.trim() === '') throw new Error('信件主旨不得為空');
  if (/[\r\n]/.test(message.subject)) throw new Error('信件主旨不得含換行');
  if (message.text.trim() === '') throw new Error('信件本文不得為空');
  if (message.from !== undefined) {
    if (message.from.trim() === '') throw new Error('寄件名義不得為空');
    if (/[\r\n]/.test(message.from)) throw new Error('寄件名義不得含換行');
    if (message.from.length > MAIL_FROM_MAX_LENGTH) throw new Error(`寄件名義不得超過 ${MAIL_FROM_MAX_LENGTH} 字`);
  }
  if (!MAIL_KIND_PATTERN.test(message.kind)) throw new Error('信件種類格式必須是「領域.動作」');
}

import { createLogMailer, type LogMailer, type LoggedMail } from './log-mailer';
import type { Mailer, SentMail } from './types';

// Mailer 的取得入口。app 內只從這裡拿，不直接建 adapter。
// 環境變數 MAILER_ADAPTER：目前只有 log（本機預設，正式環境必須明確設定）。真實寄信服務還沒選定，設成別的值一律拒絕，
// 不得默默退回 log，否則正式環境會把驗證碼寫進 log 而不自知。

export { type MailMessage, type Mailer, type SentMail } from './types';
export type { LoggedMail } from './log-mailer';

export const MAILER_ADAPTER_ENV = 'MAILER_ADAPTER';

// 掛 globalThis：dev 模式模組重載、route 與 server component 各自的模組圖，都要拿到同一個 log adapter
const g = globalThis as unknown as { __rentPocLogMailer?: LogMailer; __rentPocMailerOverride?: Mailer };

/** 測試用：換掉 getMailer() 的回傳。傳 undefined 復原。 */
export function setMailer(mailer: Mailer | undefined): void {
  g.__rentPocMailerOverride = mailer;
}

/**
 * 目前要用的 adapter 名稱。本機與測試沒設定時是 log；正式環境（NODE_ENV=production）必須明確設定，
 * 沒設定回傳 null。否則忘了設定的正式環境會把驗證碼寫進 log，/demo/otp 也會把它們列給任何人看
 * （log adapter 只因 demo 只放測試資料才可接受，ADR-0022 決議 3）。
 */
export function mailerAdapterName(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const name = env[MAILER_ADAPTER_ENV]?.trim();
  if (name) return name;
  return env.NODE_ENV === 'production' ? null : 'log';
}

export function getMailer(env: Readonly<Record<string, string | undefined>> = process.env): Mailer {
  if (g.__rentPocMailerOverride) return g.__rentPocMailerOverride;
  const name = mailerAdapterName(env);
  if (name === null) throw new Error(`正式環境必須設定 ${MAILER_ADAPTER_ENV}。目前只有 log，真實寄信服務在 pilot 前選定`);
  if (name !== 'log') throw new Error(`${MAILER_ADAPTER_ENV}=${name} 不存在。目前只有 log，真實寄信服務在 pilot 前選定`);
  return (g.__rentPocLogMailer ??= createLogMailer());
}

/**
 * demo 的驗證碼頁用。只有目前的 adapter 是 log 時才回傳信件，否則回傳 null，頁面據此 404。
 * 測試用 setMailer 換成別的 adapter 時、正式環境沒明確設定時也是 null。
 */
export function recentLoggedMail(env: Readonly<Record<string, string | undefined>> = process.env): readonly LoggedMail[] | null {
  if (g.__rentPocMailerOverride) return null;
  if (mailerAdapterName(env) !== 'log') return null;
  return (g.__rentPocLogMailer ??= createLogMailer()).recent();
}

/**
 * demo 的寄件紀錄頁用（MIL-120）。Mock 模式＝目前的 adapter 是 log（信不離開程序，只留在記憶體）。
 * 其他情況回傳 null，頁面據此 404：真實寄信服務、正式環境沒明確設定、測試換了 adapter。
 * 與 recentLoggedMail 的差別：這個回傳 SentMail，包含寄件名義。
 */
export async function listMockMail(env: Readonly<Record<string, string | undefined>> = process.env): Promise<readonly SentMail[] | null> {
  if (g.__rentPocMailerOverride) return null;
  if (mailerAdapterName(env) !== 'log') return null;
  return (g.__rentPocLogMailer ??= createLogMailer()).listSent();
}

/** 目前是不是 Mock 模式。demo 專用的觸發入口用它決定要不要 404。 */
export function isMockMailerMode(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return !g.__rentPocMailerOverride && mailerAdapterName(env) === 'log';
}

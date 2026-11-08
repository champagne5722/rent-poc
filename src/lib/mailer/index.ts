import { createLogMailer, type LogMailer, type LoggedMail } from './log-mailer';
import type { Mailer } from './types';

// Mailer 的取得入口。app 內只從這裡拿，不直接建 adapter。
// 環境變數 MAILER_ADAPTER：目前只有 log（預設）。真實寄信服務還沒選定，設成別的值一律拒絕，
// 不得默默退回 log，否則正式環境會把驗證碼寫進 log 而不自知。

export { type MailMessage, type Mailer } from './types';
export type { LoggedMail } from './log-mailer';

export const MAILER_ADAPTER_ENV = 'MAILER_ADAPTER';

// 掛 globalThis：dev 模式模組重載、route 與 server component 各自的模組圖，都要拿到同一個 log adapter
const g = globalThis as unknown as { __rentPocLogMailer?: LogMailer; __rentPocMailerOverride?: Mailer };

/** 測試用：換掉 getMailer() 的回傳。傳 undefined 復原。 */
export function setMailer(mailer: Mailer | undefined): void {
  g.__rentPocMailerOverride = mailer;
}

export function mailerAdapterName(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env[MAILER_ADAPTER_ENV]?.trim() || 'log';
}

export function getMailer(env: Readonly<Record<string, string | undefined>> = process.env): Mailer {
  if (g.__rentPocMailerOverride) return g.__rentPocMailerOverride;
  const name = mailerAdapterName(env);
  if (name !== 'log') throw new Error(`MAILER_ADAPTER=${name} 不存在。目前只有 log，真實寄信服務在 pilot 前選定`);
  return (g.__rentPocLogMailer ??= createLogMailer());
}

/**
 * demo 的驗證碼頁用。只有目前的 adapter 是 log 時才回傳信件，否則回傳 null，頁面據此 404。
 * 測試用 setMailer 換成別的 adapter 時也是 null。
 */
export function recentLoggedMail(env: Readonly<Record<string, string | undefined>> = process.env): readonly LoggedMail[] | null {
  if (g.__rentPocMailerOverride) return null;
  if (mailerAdapterName(env) !== 'log') return null;
  return ((g.__rentPocLogMailer ??= createLogMailer())).recent();
}

import { getMailer } from '../mailer';
import type { LoginDeps } from './login-flow';
import { resolveAuthSecret } from './crypto';

/** route 用的組合點：時間、金鑰、寄信與環境變數都在這裡取，login-flow 本身不讀全域。 */
export function loginDeps(): LoginDeps {
  return { now: new Date(), secret: resolveAuthSecret(process.env), mailer: getMailer(), env: process.env };
}

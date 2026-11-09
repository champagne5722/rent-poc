import { createHash, timingSafeEqual } from 'node:crypto';

// demo 環境的存取保護（ADR-0011）。系統還沒有登入，公開網址必須先擋一層 Basic Auth。
// webhook 由點點簽伺服器呼叫，帶不了帳號密碼，改由 route 內的 HMAC 驗簽保護。
// 內部 job（ADR-0020）由 Cloud Scheduler 呼叫，一樣帶不了帳號密碼，改由 route 內驗 OIDC token 保護。
// 放行的只有 /api/internal/jobs/:name 這個形狀，其他內部路徑不放行。
const PUBLIC_PATHS = new Set(['/api/webhooks/dottedsign', '/api/health']);
const JOB_PATH = /^\/api\/internal\/jobs\/[a-z][a-z0-9-]*$/;

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname) || JOB_PATH.test(pathname);
}

export type DemoAccess = 'allow' | 'challenge' | 'misconfigured';

export function decideDemoAccess(input: {
  pathname: string;
  authorization: string | null;
  user: string | undefined;
  password: string | undefined;
  onCloudRun: boolean;
}): DemoAccess {
  if (isPublicPath(input.pathname)) return 'allow';
  if (!input.user || !input.password) {
    // 本機開發不設定密碼。Cloud Run 上少了密碼時必須擋下，不得變成公開開放。
    return input.onCloudRun ? 'misconfigured' : 'allow';
  }
  return credentialsMatch(input.authorization, input.user, input.password) ? 'allow' : 'challenge';
}

function credentialsMatch(authorization: string | null, user: string, password: string): boolean {
  if (!authorization?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(authorization.slice('Basic '.length), 'base64').toString('utf8');
  // 只有帳號不能含冒號，密碼能含冒號（RFC 7617）
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;
  const userMatches = safeEqual(decoded.slice(0, separator), user);
  const passwordMatches = safeEqual(decoded.slice(separator + 1), password);
  return userMatches && passwordMatches;
}

// 先雜湊成等長，timingSafeEqual 才不會因長度不同而丟例外
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

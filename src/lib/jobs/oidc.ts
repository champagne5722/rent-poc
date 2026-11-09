import { createPublicKey, createVerify } from 'node:crypto';

// 內部 job route 的呼叫者驗證（ADR-0020 決議 2）。
// Cloud Scheduler 的 HTTP target 帶 Google 簽發的 OIDC ID token（RS256 的 JWT）。
// 驗證三項，缺一不可：簽章（Google 公開金鑰）、aud（等於設定的受眾）、email（等於設定的 service account）。
// 不引入 JWT 套件：只收 RS256，路徑短，自己寫比套件的選項面積小。

export interface OidcConfig {
  /** Cloud Scheduler job 設定的 audience。 */
  audience: string;
  /** Cloud Scheduler 用的 service account email。 */
  serviceAccount: string;
}

export type OidcFailure =
  | 'malformed'
  | 'bad_algorithm'
  | 'unknown_key'
  | 'bad_signature'
  | 'bad_issuer'
  | 'bad_audience'
  | 'expired'
  | 'not_yet_valid'
  | 'bad_service_account'
  /** 取不到 Google 的金鑰。不是呼叫者的錯，route 回 503 讓排程重試。 */
  | 'keys_unavailable';

export type OidcVerdict = { ok: true; email: string } | { ok: false; reason: OidcFailure };

export interface OidcDeps {
  /** 依 kid 取公開金鑰。找不到回 undefined，取不到（網路）丟例外。 */
  keys: (kid: string) => Promise<JsonWebKey | undefined>;
  /** 現在時間（毫秒），測試用。 */
  now?: () => number;
}

const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
/** 時鐘誤差容許，秒。 */
const SKEW_S = 60;

const decodeJson = (part: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const fail = (reason: OidcFailure): OidcVerdict => ({ ok: false, reason });

export async function verifyOidcToken(token: string, config: OidcConfig, deps: OidcDeps): Promise<OidcVerdict> {
  const parts = token.split('.');
  if (parts.length !== 3) return fail('malformed');
  const [headerPart, payloadPart, signaturePart] = parts;
  if (headerPart === '' || payloadPart === '') return fail('malformed');
  const header = decodeJson(headerPart);
  const payload = decodeJson(payloadPart);
  if (!header || !payload) return fail('malformed');

  // 先驗演算法與簽章，通過之後才相信 payload 的內容
  if (header.alg !== 'RS256') return fail('bad_algorithm');
  if (typeof header.kid !== 'string' || header.kid === '') return fail('unknown_key');
  let jwk: JsonWebKey | undefined;
  try {
    jwk = await deps.keys(header.kid);
  } catch {
    return fail('keys_unavailable');
  }
  if (!jwk) return fail('unknown_key');

  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerPart}.${payloadPart}`);
    if (!verifier.verify(createPublicKey({ key: jwk as import('node:crypto').JsonWebKey, format: 'jwk' }), Buffer.from(signaturePart, 'base64url'))) {
      return fail('bad_signature');
    }
  } catch {
    return fail('bad_signature');
  }

  const nowS = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  if (typeof payload.iss !== 'string' || !ISSUERS.has(payload.iss)) return fail('bad_issuer');
  const aud = payload.aud;
  const audienceOk = typeof aud === 'string' ? aud === config.audience : Array.isArray(aud) && aud.includes(config.audience);
  if (!audienceOk) return fail('bad_audience');
  if (typeof payload.exp !== 'number' || payload.exp + SKEW_S < nowS) return fail('expired');
  if (typeof payload.iat === 'number' && payload.iat - SKEW_S > nowS) return fail('not_yet_valid');
  if (typeof payload.nbf === 'number' && payload.nbf - SKEW_S > nowS) return fail('not_yet_valid');
  if (payload.email_verified !== true || payload.email !== config.serviceAccount) return fail('bad_service_account');
  return { ok: true, email: config.serviceAccount };
}

/** 取出 `Authorization: Bearer <token>` 的 token。其他形式回 null。 */
export function bearerToken(authorization: string | null): string | null {
  const match = /^bearer ([^\s]+)$/i.exec(authorization ?? '');
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Google 公開金鑰

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
/** 金鑰快取時間。Google 約每日輪替，快取一小時足夠。 */
const KEY_TTL_MS = 60 * 60 * 1000;
/** 遇到不認得的 kid 時最多多久重抓一次，避免被亂填 kid 的請求打爆 Google。 */
const REFETCH_MIN_MS = 60 * 1000;

export interface GoogleKeySourceOptions {
  fetchCerts?: () => Promise<Array<JsonWebKey & { kid?: string }>>;
  now?: () => number;
}

/** 帶快取的 Google 金鑰來源。kid 不在快取時重抓一次（輪替當下），但重抓有最短間隔。 */
export function createGoogleKeySource(options: GoogleKeySourceOptions = {}): OidcDeps['keys'] {
  const now = options.now ?? Date.now;
  const fetchCerts =
    options.fetchCerts ??
    (async () => {
      const response = await fetch(GOOGLE_CERTS_URL, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Google 金鑰端點回 ${response.status}`);
      const body = (await response.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
      return body.keys ?? [];
    });
  let cache = new Map<string, JsonWebKey>();
  let fetchedAt = -Infinity;

  return async (kid) => {
    const stale = now() - fetchedAt > KEY_TTL_MS;
    const missing = !cache.has(kid);
    if (stale || (missing && now() - fetchedAt > REFETCH_MIN_MS)) {
      const keys = await fetchCerts();
      cache = new Map(keys.flatMap((k) => (k.kid ? [[k.kid, k] as const] : [])));
      fetchedAt = now();
    }
    return cache.get(kid);
  };
}

/** 讀環境變數。兩個都有才算設定完成。 */
export function oidcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  const audience = env.JOBS_OIDC_AUDIENCE?.trim();
  const serviceAccount = env.JOBS_OIDC_SERVICE_ACCOUNT?.trim();
  return audience && serviceAccount ? { audience, serviceAccount } : null;
}

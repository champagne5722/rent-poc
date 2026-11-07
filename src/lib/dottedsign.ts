// 點點簽 HTTP client：認證、token 快取與帶 token 的請求。細節見 docs/dottedsign-integration.md。
// 請求內容的翻譯在 signing-module/dottedsign-adapter.ts。
//
// 模式切換：設好 DOTTEDSIGN_CLIENT_ID 與 DOTTEDSIGN_CLIENT_SECRET 即為 live，否則為 mock。
// 只有 signing-module/index.ts 用它選 adapter。contract-files.ts 的 mock 特例留給文件保存那張票。

const API_BASE = process.env.DOTTEDSIGN_API_BASE ?? 'https://api.sandbox.dottedsign.com';
const CLIENT_ID = process.env.DOTTEDSIGN_CLIENT_ID;
const CLIENT_SECRET = process.env.DOTTEDSIGN_CLIENT_SECRET;
const SCOPES = 'sign_tasks.general.write sign_tasks.general.read sign_tasks.management.write sign_tasks.download.read';

export function isMockMode(): boolean {
  return !CLIENT_ID || !CLIENT_SECRET;
}

export function dsClientSecret(): string {
  return CLIENT_SECRET ?? '';
}

interface TokenCache {
  accessToken: string;
  expiresAt: number; // epoch ms
}
const globalForToken = globalThis as unknown as { __dsToken?: TokenCache };

async function getAccessToken(): Promise<string> {
  const cached = globalForToken.__dsToken;
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;

  const res = await fetch(`${API_BASE}/v1/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: SCOPES,
    }),
  });
  if (!res.ok) throw new Error(`點點簽 token 取得失敗（${res.status}）：${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  globalForToken.__dsToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return json.access_token;
}

export async function dsFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`點點簽 API ${path} 失敗（${res.status}）：${await res.text()}`);
  return res.json();
}

// 帶 token 的 GET，供其他模組組好 path 後呼叫（例：contract-files.ts 的下載連結查詢）
export async function dsGetJson(path: string): Promise<unknown> {
  return dsFetch(path);
}

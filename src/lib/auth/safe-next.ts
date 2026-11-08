// 登入後要回去的路徑（?next=）。只接受站內的相對路徑，避免被導到外部網站（open redirect）。
// 瀏覽器解析網址時會去掉 tab 與換行，所以 "/\t/evil.com" 會變成 "//evil.com"。
// 這裡先拒絕控制字元與反斜線，再用 URL 解析確認 origin 沒變，兩道都過才採用。
// 純函式，server 與 client 都能用。

const PLACEHOLDER_ORIGIN = 'http://rent-poc.invalid';

export function safeNextPath(raw: string | string[] | undefined, fallback = '/'): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !value.startsWith('/') || value.startsWith('//')) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(value, PLACEHOLDER_ORIGIN);
  } catch {
    return fallback;
  }
  if (parsed.origin !== PLACEHOLDER_ORIGIN) return fallback;
  // 登入頁自己不是登入後的目的地
  if (parsed.pathname === '/login' || parsed.pathname.startsWith('/login/')) return fallback;
  return value;
}

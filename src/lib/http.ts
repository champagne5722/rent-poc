// route handler 的 JSON 回應（ADR-0012 決議 14，MIL-80）。
// 這是 src 內唯一可以呼叫 Response.json 的檔案，ESLint 禁止其他地方直接用（eslint.config.mjs）。
//
// 為什麼要包：Response.json 的參數型別是 any，漏寫 await 時 tsc 不報錯，
// Promise 被序列化成 {}，前端拿到空物件。MIL-37 量到 24 處，其中 9 處 lint 也抓不到。

/** 深層把 Promise 變成 never。T & NoPromise<T> 在任何一層含 Promise 時無法被賦值。 */
type NoPromise<T> = T extends PromiseLike<unknown>
  ? never
  : T extends object
    ? { [K in keyof T]: NoPromise<T[K]> }
    : T;

export interface JsonInit {
  status?: number;
  headers?: HeadersInit;
}

/**
 * 成功的 JSON 回應。body 就是回應本文，形狀由呼叫端決定（慣例是 { data: ... }）。
 * 以下三種漏 await 的寫法都讓 tsc 報錯：
 *   jsonOk(getThing())                  // 整個 body 是 Promise
 *   jsonOk({ data: getThing() })        // 屬性是 Promise
 *   jsonOk({ data: [getThing()] })      // 陣列或巢狀物件裡有 Promise
 */
export function jsonOk<T>(body: T & NoPromise<T>, init: JsonInit = {}): Response {
  // 型別擋不到 any 與 unknown 轉型的洩漏，執行期再擋一次：寧可 500，也不要回 {}
  assertNoPromise(body, '$');
  return Response.json(body, init);
}

/** 錯誤回應，本文固定是 { error: message }。 */
export function jsonError(status: number, message: string): Response {
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    throw new RangeError(`jsonError 的狀態碼必須是 4xx 或 5xx，收到 ${status}`);
  }
  return Response.json({ error: message }, { status });
}

const MAX_DEPTH = 20;

function assertNoPromise(value: unknown, path: string, depth = 0): void {
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return;
  if (typeof (value as { then?: unknown }).then === 'function') {
    throw new TypeError(`jsonOk 的內容在 ${path} 含有 Promise，漏了 await`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoPromise(item, `${path}[${i}]`, depth + 1));
    return;
  }
  for (const [key, item] of Object.entries(value)) assertNoPromise(item, `${path}.${key}`, depth + 1);
}

/** 讀 JSON 本文。不是合法的 JSON 時回 undefined，呼叫端回 400。 */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

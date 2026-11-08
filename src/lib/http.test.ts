import { describe, expect, it } from 'vitest';
import { jsonError, jsonOk } from './http';

async function getThing(): Promise<{ id: string }> {
  return { id: 'x' };
}

describe('jsonOk', () => {
  it('body 原樣序列化，預設 200', async () => {
    const res = jsonOk({ data: { id: '1' }, extra: [1, 2] });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ data: { id: '1' }, extra: [1, 2] });
  });

  it('可指定狀態碼與標頭', async () => {
    const res = jsonOk({ data: { id: '1' } }, { status: 201, headers: { 'x-test': '1' } });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-test')).toBe('1');
  });

  it('await 之後的值可以傳', async () => {
    const res = jsonOk({ data: await getThing() });
    expect(await res.json()).toEqual({ data: { id: 'x' } });
  });

  it('介面型別、可為空的欄位、唯讀陣列都可以傳', () => {
    interface Row {
      id: string;
      note: string | null;
      tags: readonly string[];
    }
    const row: Row = { id: '1', note: null, tags: ['a'] };
    expect(jsonOk({ data: row }).status).toBe(200);
    expect(jsonOk({ data: [row, row] }).status).toBe(200);
    expect(jsonOk(null).status).toBe(200);
  });

  it('型別擋不到的 Promise（轉成 any）執行期丟錯，不會回 {}', () => {
    const leaked = getThing() as unknown as { id: string };
    expect(() => jsonOk(leaked)).toThrow(/Promise/);
    expect(() => jsonOk({ data: { items: [leaked] } } as never)).toThrow(/\$\.data\.items\[0\]/);
  });
});

describe('jsonOk 漏 await 的三種寫法讓 tsc 報錯（由 tsc 驗證）', () => {
  const never = () => {
    // 1. 整個 body 是 Promise
    // @ts-expect-error body 是 Promise
    jsonOk(getThing());
    // 2. 屬性是 Promise
    // @ts-expect-error data 是 Promise
    jsonOk({ data: getThing() });
    // 3. 陣列或巢狀物件裡有 Promise
    // @ts-expect-error 陣列元素是 Promise
    jsonOk({ data: [getThing()] });
    // @ts-expect-error 巢狀兩層仍然抓得到
    jsonOk({ data: { items: [{ thing: getThing() }] } });
    // @ts-expect-error async map 的結果是 Promise 陣列
    jsonOk({ data: [1, 2].map(async (n) => n) });

    // 正確寫法
    return async () => jsonOk({ data: await getThing(), list: await Promise.all([getThing()]) });
  };
  it('編譯通過即為通過', () => {
    expect(typeof never).toBe('function');
  });
});

describe('jsonError', () => {
  it('本文是 { error }，帶指定的狀態碼', async () => {
    const res = jsonError(404, '合約不存在');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: '合約不存在' });
  });

  it('帶 code 時本文是 { error, code }，讓前端分辨原因', async () => {
    const res = jsonError(409, '請先確認', 'needs_confirmation');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: '請先確認', code: 'needs_confirmation' });
  });

  it('狀態碼不是 4xx 或 5xx 時丟錯，避免把錯誤回成 200', () => {
    expect(() => jsonError(200, 'x')).toThrow(RangeError);
    expect(() => jsonError(302, 'x')).toThrow(RangeError);
  });
});

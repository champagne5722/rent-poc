import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { GET as getAreas } from './areas/route';
import { GET as getSections } from './sections/route';

// MIL-143：產權區塊的選單資料。公開的政府段碼表，不需要組織脈絡，也不碰資料庫。
// 用 2026-11-08 的真實資料：臺北市(A) 大安區(02) 有龍泉 一（0021）；新北市(F) 中和區(18) 與永和區(33) 共有跨越段 1818。

const json = (res: Response) => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const sections = (query: string) => getSections(new NextRequest(`http://localhost/api/registry/sections?${query}`));

describe('GET /api/registry/areas', () => {
  it('回全部縣市與鄉鎮市區，名稱一律是「臺」', async () => {
    const res = await getAreas();
    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data.cities).toHaveLength(22);
    expect(data.towns).toHaveLength(365);
    expect(data.cities).toContainEqual({ code: 'A', name: '臺北市' });
    expect(data.towns).toContainEqual({ cityCode: 'A', code: '02', name: '大安區' });
    expect(JSON.stringify(data)).not.toContain('台');
  });
});

describe('GET /api/registry/sections', () => {
  it('列出鄉鎮市區可選的段，附段碼與顯示名稱', async () => {
    const res = await sections('city=A&town=02');
    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data).toContainEqual({ code: '0021', label: '龍泉 一', via_alias: false });
  });

  it('已註銷的段不出現在選單', async () => {
    // 臺北市松山區 0610 延吉 二 已註銷
    const { data } = await json(await sections('city=A&town=01'));
    expect(data.map((s: { code: string }) => s.code)).not.toContain('0610');
    expect(data.length).toBeGreaterThan(0);
  });

  it('跨越段從別名行政區也選得到，標記 via_alias', async () => {
    const main = await json(await sections('city=F&town=18'));
    const alias = await json(await sections('city=F&town=33'));
    expect(main.data).toContainEqual(expect.objectContaining({ code: '1818', via_alias: false }));
    expect(alias.data).toContainEqual(expect.objectContaining({ code: '1818', via_alias: true }));
  });

  it('可用段名搜尋，「台」視同「臺」，空白不影響', async () => {
    const { data } = await json(await sections('city=A&town=02&q=龍泉'));
    expect(data.map((s: { code: string }) => s.code)).toEqual(['0021', '0022', '0023']);
    const spaced = await json(await sections('city=A&town=02&q=' + encodeURIComponent('龍泉 二')));
    expect(spaced.data.map((s: { code: string }) => s.code)).toEqual(['0022']);
  });

  it('沒給縣市或鄉鎮市區回 400；不存在的鄉鎮市區回空陣列', async () => {
    expect((await sections('town=02')).status).toBe(400);
    expect((await sections('city=A')).status).toBe(400);
    expect(await json(await sections('city=A&town=99'))).toEqual({ data: [] });
  });
});

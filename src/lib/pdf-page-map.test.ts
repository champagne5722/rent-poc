import { describe, expect, it } from 'vitest';
import { findSignaturePage, findStatusAnnexPage, pageMapFromTexts } from './pdf-layout';

// 簽名頁與附件頁由 PDF 的文字判定，不用「最後一頁」推測（MIL-162）。

const BODY = '房屋租賃契約書甲方（出租人）：王大明';
const SIGNATURE = '立契約書人甲方（出租人）：王大明簽章：';
const EQUIPMENT = '附件　附屬設備清單項目數量';
const STATUS = '附件　現況確認附件本附件為本契約之一部分';

describe('findSignaturePage', () => {
  it('沒有附件時是最後一頁', () => {
    expect(findSignaturePage([BODY, BODY, SIGNATURE])).toBe(2);
  });

  it('有設備附件時，簽名頁是「立契約書人」所在的頁，不是最後一頁', () => {
    expect(findSignaturePage([BODY, SIGNATURE, EQUIPMENT])).toBe(1);
  });

  it('有設備附件與現況確認附件時也找得到', () => {
    expect(findSignaturePage([BODY, BODY, SIGNATURE, EQUIPMENT, STATUS])).toBe(2);
  });

  it('pdf.js 把文字拆開、夾空白時仍找得到', () => {
    expect(findSignaturePage([BODY, '立契約書 人 甲方', EQUIPMENT])).toBe(1);
  });

  it('找不到「立契約書人」時退回最後一頁', () => {
    expect(findSignaturePage([BODY, BODY, EQUIPMENT])).toBe(2);
  });

  it('沒有任何頁時是 0', () => {
    expect(findSignaturePage([])).toBe(0);
  });
});

describe('findStatusAnnexPage', () => {
  it('找到標題「附件　現況確認附件」所在的頁', () => {
    expect(findStatusAnnexPage([BODY, SIGNATURE, EQUIPMENT, STATUS])).toBe(3);
  });

  it('本文只是提到現況確認附件、沒有附件標題時不算', () => {
    expect(findStatusAnnexPage([`${BODY}詳如現況確認附件`, SIGNATURE])).toBeNull();
  });

  it('沒有附件頁回 null', () => {
    expect(findStatusAnnexPage([BODY, SIGNATURE, EQUIPMENT])).toBeNull();
  });
});

describe('pageMapFromTexts', () => {
  it('組出與伺服器相同形狀的頁面地圖', () => {
    expect(pageMapFromTexts([BODY, SIGNATURE, EQUIPMENT, STATUS])).toEqual({
      pageCount: 4,
      signaturePage: 1,
      statusAnnexPage: 3,
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  MANDATE_SCOPES,
  MANDATE_SCOPE_LABELS,
  isScopeMandated,
  mandateItemFromProperty,
  mandateItemsIssues,
  mandateScopeText,
  mandateScopesOf,
  parseMandateSelection,
  resolveMandateItems,
  type MandateItem,
} from './index';

// 委託標的清單與委託範圍（MIL-74、P0-11）：純函式，client 與 server 都能引用。

const ITEM_A: MandateItem = {
  propertyId: '7',
  propertyName: '信義小宅',
  propertyAddress: '台北市信義區松仁路 1 號',
  scopes: ['rent_collection', 'repair'],
};
const ITEM_B: MandateItem = {
  propertyId: '9',
  propertyName: '大安套房',
  propertyAddress: '台北市大安區和平東路 2 號',
  scopes: ['deposit_management', 'handover'],
};

describe('委託範圍', () => {
  it('有收租、押金管理、修繕、點交四項，標籤照術語表', () => {
    expect(MANDATE_SCOPES).toEqual(['rent_collection', 'deposit_management', 'repair', 'handover']);
    expect(MANDATE_SCOPES.map((s) => MANDATE_SCOPE_LABELS[s])).toEqual(['收租', '押金管理', '修繕', '點交']);
  });

  it('文字依固定順序排列，不受勾選順序影響', () => {
    expect(mandateScopeText(['handover', 'rent_collection'])).toBe('收租、點交');
    expect(mandateScopeText([])).toBe('（未勾選）');
  });
});

describe('從物件建立清單列', () => {
  it('快照名稱與地址，編號轉成字串，預設沒有勾選範圍', () => {
    const item = mandateItemFromProperty({ id: 7, name: '信義小宅', address: '台北市信義區松仁路 1 號' });
    expect(item).toEqual({
      propertyId: '7',
      propertyName: '信義小宅',
      propertyAddress: '台北市信義區松仁路 1 號',
      scopes: [],
    });
  });

  it('編號已是字串時原樣保留', () => {
    expect(mandateItemFromProperty({ id: 'prop-1', name: 'a', address: 'b' }).propertyId).toBe('prop-1');
  });
});

describe('清單檢核', () => {
  it('兩列都有範圍時沒有問題', () => {
    expect(mandateItemsIssues([ITEM_A, ITEM_B])).toEqual([]);
  });

  it('空清單要擋下', () => {
    expect(mandateItemsIssues([])).toEqual(['委託標的清單至少要有一個租賃單位']);
  });

  it('某列沒有勾選任何範圍，指出是哪個租賃單位', () => {
    expect(mandateItemsIssues([ITEM_A, { ...ITEM_B, scopes: [] }])).toEqual(['大安套房尚未勾選委託範圍']);
  });

  it('同一個租賃單位出現兩列要擋下', () => {
    expect(mandateItemsIssues([ITEM_A, { ...ITEM_A }])).toEqual(['信義小宅在清單中重複']);
  });
});

describe('委託範圍的查詢', () => {
  it('依租賃單位查範圍，順序固定', () => {
    expect(mandateScopesOf([ITEM_A, ITEM_B], '9')).toEqual(['deposit_management', 'handover']);
  });

  it('不在清單的租賃單位沒有任何範圍', () => {
    expect(mandateScopesOf([ITEM_A], '99')).toEqual([]);
  });

  it('判斷某個動作是否在委託範圍內', () => {
    expect(isScopeMandated([ITEM_A], '7', 'repair')).toBe(true);
    expect(isScopeMandated([ITEM_A], '7', 'handover')).toBe(false);
  });
});

describe('解析請求中的選擇', () => {
  it('接受租賃單位編號加委託範圍，編號數字轉字串', () => {
    expect(parseMandateSelection({ items: [{ propertyId: 7, scopes: ['repair'] }, { propertyId: 'x', scopes: [] }] })).toEqual([
      { propertyId: '7', scopes: ['repair'] },
      { propertyId: 'x', scopes: [] },
    ]);
  });

  it('格式不對、範圍不認得、編號是空的都回 null', () => {
    expect(parseMandateSelection(null)).toBeNull();
    expect(parseMandateSelection({ items: 'x' })).toBeNull();
    expect(parseMandateSelection({ items: [{ propertyId: 7, scopes: ['sell'] }] })).toBeNull();
    expect(parseMandateSelection({ items: [{ propertyId: '', scopes: [] }] })).toBeNull();
    expect(parseMandateSelection({ items: [{ scopes: [] }] })).toBeNull();
  });
});

describe('選擇換成清單：已存的列保留原快照，新加的列才取物件現況', () => {
  const lookup = (id: string) => (id === '9' ? { name: '大安套房（改名後）', address: '新地址' } : null);

  it('已存的列沿用原本的名稱與地址快照，只更新範圍', () => {
    const result = resolveMandateItems([{ propertyId: '7', scopes: ['handover'] }], [ITEM_A], lookup);
    expect(result).toEqual({ ok: true, items: [{ ...ITEM_A, scopes: ['handover'] }] });
  });

  it('新加的列取物件當下的名稱與地址', () => {
    const result = resolveMandateItems(
      [{ propertyId: '7', scopes: ['repair'] }, { propertyId: '9', scopes: ['repair'] }],
      [ITEM_A],
      lookup,
    );
    expect(result).toEqual({
      ok: true,
      items: [
        { ...ITEM_A, scopes: ['repair'] },
        { propertyId: '9', propertyName: '大安套房（改名後）', propertyAddress: '新地址', scopes: ['repair'] },
      ],
    });
  });

  it('列的順序照選擇的順序', () => {
    const result = resolveMandateItems([{ propertyId: '9', scopes: [] }, { propertyId: '7', scopes: [] }], [ITEM_A], lookup);
    if (!result.ok) throw new Error(result.error);
    expect(result.items.map((i) => i.propertyId)).toEqual(['9', '7']);
  });

  it('查不到的物件回錯誤，不寫入', () => {
    expect(resolveMandateItems([{ propertyId: '404', scopes: [] }], [], lookup)).toEqual({
      ok: false,
      error: '找不到物件 404',
    });
  });

  it('同一個物件選兩次回錯誤', () => {
    expect(resolveMandateItems([{ propertyId: '7', scopes: [] }, { propertyId: '7', scopes: [] }], [ITEM_A], lookup)).toEqual({
      ok: false,
      error: '同一個租賃單位只能選一次',
    });
  });
});

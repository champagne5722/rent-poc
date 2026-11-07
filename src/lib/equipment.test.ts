import { describe, expect, it } from 'vitest';
import {
  contractEquipmentAnnex,
  formatEquipmentItem,
  parseEquipmentLabel,
  parseEquipmentPayload,
  parseStoredEquipment,
  toEquipmentAnnex,
} from './equipment';
import type { EquipmentAnnexRow } from './types';

describe('parseStoredEquipment：讀既有 JSON 欄位', () => {
  it('舊格式字串陣列一律視為數量 1', () => {
    expect(parseStoredEquipment('["冷氣","洗衣機"]')).toEqual([
      { name: '冷氣', quantity: 1 },
      { name: '洗衣機', quantity: 1 },
    ]);
  });

  it('新格式原樣讀回，數量取整數下限 1', () => {
    expect(parseStoredEquipment('[{"name":"冷氣","quantity":3},{"name":"床","quantity":0}]')).toEqual([
      { name: '冷氣', quantity: 3 },
      { name: '床', quantity: 1 },
    ]);
  });

  it('新舊混雜的陣列也吃得下', () => {
    expect(parseStoredEquipment('["冷氣",{"name":"床","quantity":2}]')).toEqual([
      { name: '冷氣', quantity: 1 },
      { name: '床', quantity: 2 },
    ]);
  });

  it('空值、壞 JSON 與非陣列都回空清單，不讓讀取整頁失敗', () => {
    expect(parseStoredEquipment('')).toEqual([]);
    expect(parseStoredEquipment('not json')).toEqual([]);
    expect(parseStoredEquipment('{"name":"冷氣"}')).toEqual([]);
    expect(parseStoredEquipment(null)).toEqual([]);
  });

  it('名稱空白的項目直接丟掉，名稱前後空白去掉', () => {
    expect(parseStoredEquipment('["  冷氣 ", "   ", {"name":"","quantity":2}]')).toEqual([
      { name: '冷氣', quantity: 1 },
    ]);
  });

  it('同名項目合併，保留先出現者的數量', () => {
    expect(parseStoredEquipment('[{"name":"冷氣","quantity":2},{"name":"冷氣","quantity":5}]')).toEqual([
      { name: '冷氣', quantity: 2 },
    ]);
  });
});

describe('parseEquipmentPayload：API 進來的設備清單驗證', () => {
  it('合法清單原樣回傳', () => {
    expect(parseEquipmentPayload([{ name: '冷氣', quantity: 2 }])).toEqual([{ name: '冷氣', quantity: 2 }]);
  });

  it('未給值當成空清單', () => {
    expect(parseEquipmentPayload(undefined)).toEqual([]);
    expect(parseEquipmentPayload(null)).toEqual([]);
  });

  it('數量不是正整數就擋下來', () => {
    expect(parseEquipmentPayload([{ name: '冷氣', quantity: 0 }])).toBeNull();
    expect(parseEquipmentPayload([{ name: '冷氣', quantity: -1 }])).toBeNull();
    expect(parseEquipmentPayload([{ name: '冷氣', quantity: 1.5 }])).toBeNull();
    expect(parseEquipmentPayload([{ name: '冷氣', quantity: '2' }])).toBeNull();
    expect(parseEquipmentPayload([{ name: '冷氣' }])).toBeNull();
  });

  it('名稱空白、非物件、非陣列都擋下來', () => {
    expect(parseEquipmentPayload([{ name: '   ', quantity: 1 }])).toBeNull();
    expect(parseEquipmentPayload(['冷氣'])).toBeNull();
    expect(parseEquipmentPayload('冷氣')).toBeNull();
  });

  it('同名項目重複也擋下來，避免存進兩列相同設備', () => {
    expect(
      parseEquipmentPayload([
        { name: '冷氣', quantity: 1 },
        { name: '冷氣', quantity: 2 },
      ])
    ).toBeNull();
  });

  it('名稱前後空白會被修掉', () => {
    expect(parseEquipmentPayload([{ name: ' 冷氣 ', quantity: 2 }])).toEqual([{ name: '冷氣', quantity: 2 }]);
  });
});

describe('顯示', () => {
  it('數量 1 不加後綴，超過 1 顯示 ×N', () => {
    expect(formatEquipmentItem({ name: '冷氣', quantity: 1 })).toBe('冷氣');
    expect(formatEquipmentItem({ name: '冷氣', quantity: 2 })).toBe('冷氣 ×2');
  });
});

describe('parseEquipmentLabel：把顯示字串解析回項目', () => {
  it('「名稱 ×N」解析回名稱與數量', () => {
    expect(parseEquipmentLabel('冷氣 ×2')).toEqual({ name: '冷氣', quantity: 2 });
    expect(parseEquipmentLabel('冷氣×3')).toEqual({ name: '冷氣', quantity: 3 });
  });

  it('沒有數量後綴時視為 1', () => {
    expect(parseEquipmentLabel('洗衣機')).toEqual({ name: '洗衣機', quantity: 1 });
  });

  it('名稱本身含 × 但不是數量後綴時原樣保留', () => {
    expect(parseEquipmentLabel('冷氣 ×abc')).toEqual({ name: '冷氣 ×abc', quantity: 1 });
  });

  it('數量 0 或負數保底成 1', () => {
    expect(parseEquipmentLabel('冷氣 ×0')).toEqual({ name: '冷氣', quantity: 1 });
  });
});

describe('toEquipmentAnnex：物件設備清單帶入合約', () => {
  it('每項轉成一列，修繕責任預設出租方、備註空白', () => {
    expect(
      toEquipmentAnnex([
        { name: '冷氣', quantity: 2 },
        { name: '洗衣機', quantity: 1 },
      ])
    ).toEqual([
      { name: '冷氣', quantity: 2, repair: 'landlord', note: '' },
      { name: '洗衣機', quantity: 1, repair: 'landlord', note: '' },
    ]);
  });

  it('空清單轉出空陣列', () => {
    expect(toEquipmentAnnex([])).toEqual([]);
  });
});

describe('contractEquipmentAnnex：讀合約的設備附件列', () => {
  it('讀合約自己的快照', () => {
    const rows = [{ name: '冷氣', quantity: 2, repair: 'tenant' as const, note: '房客自購' }];
    expect(contractEquipmentAnnex({ equipmentAnnex: rows })).toEqual(rows);
  });

  // MIL-29 之前的合約只有壓平成字串的 equipment，比照 TemplateBinding 的可選欄位處理
  it('舊合約的字串陣列轉成附件列：數量解析回來、修繕責任出租方、備註空', () => {
    expect(contractEquipmentAnnex({ equipment: ['冷氣 ×2', '洗衣機'] })).toEqual([
      { name: '冷氣', quantity: 2, repair: 'landlord', note: '' },
      { name: '洗衣機', quantity: 1, repair: 'landlord', note: '' },
    ]);
  });

  it('兩個欄位都在時以新欄位為準', () => {
    expect(contractEquipmentAnnex({ equipmentAnnex: [], equipment: ['冷氣'] })).toEqual([]);
  });

  it('兩個欄位都沒有時是空清單', () => {
    expect(contractEquipmentAnnex({})).toEqual([]);
  });

  it('壞掉的列不讓整份附件消失：數量保底 1、修繕責任保底出租方、備註保底空字串', () => {
    const raw = [
      { name: '冷氣', quantity: 0, repair: 'nobody', note: 7 },
      { name: '  ', quantity: 1, repair: 'tenant', note: '' },
      '洗衣機 ×2',
    ] as unknown as EquipmentAnnexRow[];
    expect(contractEquipmentAnnex({ equipmentAnnex: raw })).toEqual([
      { name: '冷氣', quantity: 1, repair: 'landlord', note: '' },
      { name: '洗衣機', quantity: 2, repair: 'landlord', note: '' },
    ]);
  });
});

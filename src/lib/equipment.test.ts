import { describe, expect, it } from 'vitest';
import { formatEquipmentItem, parseEquipmentPayload, parseStoredEquipment, toContractEquipment } from './equipment';

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

describe('顯示與合約橋接', () => {
  it('數量 1 不加後綴，超過 1 顯示 ×N', () => {
    expect(formatEquipmentItem({ name: '冷氣', quantity: 1 })).toBe('冷氣');
    expect(formatEquipmentItem({ name: '冷氣', quantity: 2 })).toBe('冷氣 ×2');
  });

  // MIL-29 之前 ContractFields.equipment 仍是 string[]，建約時把數量壓平成字串
  it('建約帶入時轉成字串陣列', () => {
    expect(
      toContractEquipment([
        { name: '冷氣', quantity: 2 },
        { name: '洗衣機', quantity: 1 },
      ])
    ).toEqual(['冷氣 ×2', '洗衣機']);
  });

  it('空清單轉出空陣列', () => {
    expect(toContractEquipment([])).toEqual([]);
  });
});

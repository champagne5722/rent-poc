import { describe, expect, it } from 'vitest';
import { compareHandoverRecords, type HandoverRecordContent, type HandoverRow } from './compare';

const row = (rowNo: number, name: string, condition: string, note = ''): HandoverRow => ({
  rowNo,
  name,
  condition,
  note,
});

const record = (
  rows: readonly HandoverRow[],
  meters: HandoverRecordContent['meters'] = { electricity: 100, gas: 50, water: null },
): HandoverRecordContent => ({ meters, rows });

const BASE = record([row(0, '冷氣', '正常'), row(1, '洗衣機', '正常')]);

describe('compareHandoverRecords：設備附件逐列', () => {
  it('完全相同：每列 unchanged，沒有差異', () => {
    const result = compareHandoverRecords(BASE, BASE);
    expect(result.rows).toEqual([
      { kind: 'unchanged', rowNo: 0, name: '冷氣', condition: '正常' },
      { kind: 'unchanged', rowNo: 1, name: '洗衣機', condition: '正常' },
    ]);
    expect(result.hasRowDifferences).toBe(false);
    expect(result.counts).toEqual({ added: 0, missing: 0, changed: 0, unchanged: 2 });
  });

  it('狀態改變：同列序號、同名稱、狀態不同', () => {
    const moveOut = record([row(0, '冷氣', '損壞'), row(1, '洗衣機', '正常')]);
    const result = compareHandoverRecords(BASE, moveOut);
    expect(result.rows[0]).toEqual({ kind: 'changed', rowNo: 0, name: '冷氣', from: '正常', to: '損壞' });
    expect(result.rows[1]?.kind).toBe('unchanged');
    expect(result.hasRowDifferences).toBe(true);
    expect(result.counts).toEqual({ added: 0, missing: 0, changed: 1, unchanged: 1 });
  });

  it('缺少：入住有、退租沒有', () => {
    const moveOut = record([row(0, '冷氣', '正常')]);
    const result = compareHandoverRecords(BASE, moveOut);
    expect(result.rows[1]).toEqual({ kind: 'missing', rowNo: 1, name: '洗衣機', condition: '正常' });
    expect(result.counts.missing).toBe(1);
    expect(result.hasRowDifferences).toBe(true);
  });

  it('新增：退租有、入住沒有', () => {
    const moveOut = record([row(0, '冷氣', '正常'), row(1, '洗衣機', '正常'), row(2, '電暖器', '正常')]);
    const result = compareHandoverRecords(BASE, moveOut);
    expect(result.rows[2]).toEqual({ kind: 'added', rowNo: 2, name: '電暖器', condition: '正常' });
    expect(result.counts.added).toBe(1);
    expect(result.hasRowDifferences).toBe(true);
  });

  it('同時有新增、缺少、狀態改變，結果依列序號排序', () => {
    const moveIn = record([row(3, '熱水器', '正常'), row(0, '冷氣', '正常'), row(1, '洗衣機', '正常')]);
    const moveOut = record([row(4, '電視', '正常'), row(1, '洗衣機', '有刮痕'), row(0, '冷氣', '正常')]);
    const result = compareHandoverRecords(moveIn, moveOut);
    expect(result.rows.map((r) => [r.rowNo, r.kind])).toEqual([
      [0, 'unchanged'],
      [1, 'changed'],
      [3, 'missing'],
      [4, 'added'],
    ]);
    expect(result.counts).toEqual({ added: 1, missing: 1, changed: 1, unchanged: 1 });
  });

  it('同列序號但名稱不同：視為原項目缺少、新項目新增', () => {
    const moveOut = record([row(0, '除濕機', '正常'), row(1, '洗衣機', '正常')]);
    const result = compareHandoverRecords(BASE, moveOut);
    expect(result.rows.filter((r) => r.rowNo === 0).map((r) => r.kind)).toEqual(['missing', 'added']);
  });

  it('狀態與名稱前後空白不算差異，備註不影響對照', () => {
    const moveIn = record([row(0, ' 冷氣 ', '正常 ', '入住備註')]);
    const moveOut = record([row(0, '冷氣', ' 正常', '退租備註')]);
    expect(compareHandoverRecords(moveIn, moveOut).rows).toEqual([
      { kind: 'unchanged', rowNo: 0, name: '冷氣', condition: '正常' },
    ]);
  });

  it('兩邊都沒有設備列', () => {
    const result = compareHandoverRecords(record([]), record([]));
    expect(result.rows).toEqual([]);
    expect(result.hasRowDifferences).toBe(false);
  });

  it('不改動輸入', () => {
    const moveIn = record([row(1, 'b', '正常'), row(0, 'a', '正常')]);
    const snapshot = JSON.stringify(moveIn);
    compareHandoverRecords(moveIn, BASE);
    expect(JSON.stringify(moveIn)).toBe(snapshot);
  });

  it.each([-1, 1.5, Number.NaN])('列序號 %s 不合法丟 RangeError', (rowNo) => {
    expect(() => compareHandoverRecords(record([row(rowNo, 'x', 'y')]), BASE)).toThrow(RangeError);
  });

  it('同一份紀錄的列序號重複丟 RangeError', () => {
    const dup = record([row(0, 'a', '正常'), row(0, 'b', '正常')]);
    expect(() => compareHandoverRecords(dup, BASE)).toThrow(RangeError);
    expect(() => compareHandoverRecords(BASE, dup)).toThrow(RangeError);
  });
});

describe('compareHandoverRecords：度數差', () => {
  const withMeters = (meters: HandoverRecordContent['meters']) => record([], meters);

  it('度數增加：delta 為退租減入住', () => {
    const result = compareHandoverRecords(
      withMeters({ electricity: 100, gas: 50, water: 10 }),
      withMeters({ electricity: 350, gas: 80, water: 25 }),
    );
    expect(result.meters).toEqual([
      { meter: 'electricity', moveIn: 100, moveOut: 350, delta: 250, status: 'increased' },
      { meter: 'gas', moveIn: 50, moveOut: 80, delta: 30, status: 'increased' },
      { meter: 'water', moveIn: 10, moveOut: 25, delta: 15, status: 'increased' },
    ]);
    expect(result.hasRowDifferences).toBe(false);
  });

  it('度數相同：status same、delta 0，不算差異', () => {
    const same = withMeters({ electricity: 100, gas: 50 });
    const result = compareHandoverRecords(same, same);
    expect(result.meters[0]).toEqual({ meter: 'electricity', moveIn: 100, moveOut: 100, delta: 0, status: 'same' });
    expect(result.hasRowDifferences).toBe(false);
  });

  it('退租度數比入住小：delta 為負，status decreased（可能換表，由人判斷）', () => {
    const result = compareHandoverRecords(withMeters({ electricity: 500 }), withMeters({ electricity: 20 }));
    expect(result.meters[0]).toEqual({
      meter: 'electricity',
      moveIn: 500,
      moveOut: 20,
      delta: -480,
      status: 'decreased',
    });
    expect(result.hasRowDifferences).toBe(false);
  });

  it('水表選填：兩邊都沒填 → not_comparable，delta null，不算差異', () => {
    const result = compareHandoverRecords(withMeters({ electricity: 1 }), withMeters({ electricity: 1 }));
    expect(result.meters.find((m) => m.meter === 'water')).toEqual({
      meter: 'water',
      moveIn: null,
      moveOut: null,
      delta: null,
      status: 'not_comparable',
    });
    expect(result.hasRowDifferences).toBe(false);
  });

  it('只有一邊有度數：not_comparable，delta null', () => {
    const result = compareHandoverRecords(withMeters({ gas: 10 }), withMeters({ gas: null }));
    expect(result.meters.find((m) => m.meter === 'gas')).toEqual({
      meter: 'gas',
      moveIn: 10,
      moveOut: null,
      delta: null,
      status: 'not_comparable',
    });
  });

  it('小數度數的差不產生浮點雜訊', () => {
    const result = compareHandoverRecords(withMeters({ electricity: 100.1 }), withMeters({ electricity: 100.4 }));
    expect(result.meters[0]?.delta).toBe(0.3);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('度數 %s 不合法丟 RangeError', (value) => {
    expect(() => compareHandoverRecords(withMeters({ electricity: value }), BASE)).toThrow(RangeError);
    expect(() => compareHandoverRecords(BASE, withMeters({ gas: value }))).toThrow(RangeError);
  });

  it('度數增加是正常用量，不算設備列差異', () => {
    const moveOut = record(BASE.rows, { electricity: 130, gas: 50 });
    const result = compareHandoverRecords(BASE, moveOut);
    expect(result.hasRowDifferences).toBe(false);
    expect(result.meters[0]?.delta).toBe(30);
  });
});

// 入住與退租點交的逐列對照（MIL-136、ADR-0051 決議 3、PRD P0-17 AC4）。
// 純函式，沒有 I/O。輸出只描述差異，不判定誰該負責。

/** 度數種類。水表選填。 */
export const HANDOVER_METERS = ['electricity', 'gas', 'water'] as const;
export type HandoverMeter = (typeof HANDOVER_METERS)[number];

/** 設備附件的一列。rowNo 是合約凍結的附件列序號（非負整數），兩次點交靠它對上同一列。 */
export interface HandoverRow {
  rowNo: number;
  name: string;
  /** 該列的狀態，例如「正常」「損壞」。自由文字，前後空白不計。 */
  condition: string;
  note?: string;
}

/** 一次點交的可比較內容。度數是表上讀數，null 或沒填代表沒記錄。 */
export interface HandoverRecordContent {
  meters: Partial<Record<HandoverMeter, number | null>>;
  rows: readonly HandoverRow[];
}

export type RowDiff =
  | { kind: 'unchanged'; rowNo: number; name: string; condition: string }
  | { kind: 'changed'; rowNo: number; name: string; from: string; to: string }
  /** 退租有、入住沒有。 */
  | { kind: 'added'; rowNo: number; name: string; condition: string }
  /** 入住有、退租沒有。 */
  | { kind: 'missing'; rowNo: number; name: string; condition: string };

export type MeterStatus = 'same' | 'increased' | 'decreased' | 'not_comparable';

export interface MeterDiff {
  meter: HandoverMeter;
  moveIn: number | null;
  moveOut: number | null;
  /** 退租減入住。任一邊沒記錄時是 null。 */
  delta: number | null;
  status: MeterStatus;
}

export interface HandoverComparison {
  rows: RowDiff[];
  meters: MeterDiff[];
  /** 任何一列不是 unchanged 就是 true。度數正常會增加，所以不計入，由呼叫端看 meters。 */
  hasRowDifferences: boolean;
  counts: { added: number; missing: number; changed: number; unchanged: number };
}

function normalizeRows(rows: readonly HandoverRow[], label: string): Map<number, HandoverRow> {
  const map = new Map<number, HandoverRow>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.rowNo) || row.rowNo < 0) {
      throw new RangeError(`${label}的設備附件列序號必須是非負整數：${String(row.rowNo)}`);
    }
    if (map.has(row.rowNo)) throw new RangeError(`${label}的設備附件列序號重複：${row.rowNo}`);
    map.set(row.rowNo, row);
  }
  return map;
}

function readMeter(content: HandoverRecordContent, meter: HandoverMeter, label: string): number | null {
  const value = content.meters[meter];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label}的${meter}度數必須是非負的有限數字：${String(value)}`);
  }
  return value;
}

function diffMeter(moveIn: number | null, moveOut: number | null): Pick<MeterDiff, 'delta' | 'status'> {
  if (moveIn === null || moveOut === null) return { delta: null, status: 'not_comparable' };
  // 小數度數相減會有浮點雜訊，四捨五入到小數第六位。
  const delta = Math.round((moveOut - moveIn) * 1e6) / 1e6;
  if (delta === 0) return { delta: 0, status: 'same' };
  return { delta, status: delta > 0 ? 'increased' : 'decreased' };
}

/**
 * 對照入住與退租點交。
 * 設備列以 rowNo 配對。同一 rowNo 但名稱不同，視為原項目缺少、新項目新增。
 * 結果依 rowNo 由小到大排序。不改動輸入。
 */
export function compareHandoverRecords(
  moveIn: HandoverRecordContent,
  moveOut: HandoverRecordContent,
): HandoverComparison {
  const inRows = normalizeRows(moveIn.rows, '入住點交');
  const outRows = normalizeRows(moveOut.rows, '退租點交');

  const rowNos = [...new Set([...inRows.keys(), ...outRows.keys()])].sort((a, b) => a - b);
  const rows: RowDiff[] = [];
  for (const rowNo of rowNos) {
    const before = inRows.get(rowNo);
    const after = outRows.get(rowNo);
    if (before && after) {
      const name = before.name.trim();
      const from = before.condition.trim();
      const to = after.condition.trim();
      if (name === after.name.trim()) {
        rows.push(from === to ? { kind: 'unchanged', rowNo, name, condition: from } : { kind: 'changed', rowNo, name, from, to });
        continue;
      }
    }
    if (before) rows.push({ kind: 'missing', rowNo, name: before.name.trim(), condition: before.condition.trim() });
    if (after) rows.push({ kind: 'added', rowNo, name: after.name.trim(), condition: after.condition.trim() });
  }

  const meters = HANDOVER_METERS.map((meter): MeterDiff => {
    const before = readMeter(moveIn, meter, '入住點交');
    const after = readMeter(moveOut, meter, '退租點交');
    return { meter, moveIn: before, moveOut: after, ...diffMeter(before, after) };
  });

  const counts = { added: 0, missing: 0, changed: 0, unchanged: 0 };
  for (const row of rows) counts[row.kind] += 1;

  const hasRowDifferences = counts.added + counts.missing + counts.changed > 0;

  return { rows, meters, hasRowDifferences, counts };
}

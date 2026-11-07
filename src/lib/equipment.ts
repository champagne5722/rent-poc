// 設備清單的解析、驗證與顯示（GLOSSARY.md：設備清單、設備詞彙庫；ADR-0008）。
// 全部是純函式：資料庫讀寫在 db.ts、API 驗證在 route，畫面只負責呈現。

import type {
  EquipmentAnnexRow,
  EquipmentAnnexSnapshot,
  EquipmentItem,
  RepairResponsibility,
} from './types';
import { REPAIR_RESPONSIBILITIES } from './types';

/** 把任意值收斂成一個合法項目；名稱空白或形狀不對回 null。 */
function coerceItem(value: unknown): EquipmentItem | null {
  // 舊格式（MIL-28 之前）：整份清單是字串陣列，一律視為數量 1
  if (typeof value === 'string') {
    const name = value.trim();
    return name ? { name, quantity: 1 } : null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { name, quantity } = value as { name?: unknown; quantity?: unknown };
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  // 數量壞掉時保底成 1，讀取路徑不因為一筆髒資料就整頁失敗
  const n = typeof quantity === 'number' && Number.isFinite(quantity) ? Math.floor(quantity) : 1;
  return { name: trimmed, quantity: n >= 1 ? n : 1 };
}

/**
 * 讀 properties.equipment 這個 TEXT JSON 欄位。
 * 寬鬆處理：吃得下舊的字串陣列、新的物件陣列與兩者混雜，壞資料一律降級成空清單。
 */
export function parseStoredEquipment(raw: unknown): EquipmentItem[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const items: EquipmentItem[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const item = coerceItem(entry);
    if (!item || seen.has(item.name)) continue;
    seen.add(item.name);
    items.push(item);
  }
  return items;
}

/**
 * 驗證 API 進來的設備清單。
 * 嚴格處理：數量必須是正整數、名稱不得空白、不得同名重複；任一項不合格整份回 null 讓 route 回 400。
 * 未給值（undefined／null）視為空清單。
 */
export function parseEquipmentPayload(raw: unknown): EquipmentItem[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  const items: EquipmentItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { name, quantity } = entry as { name?: unknown; quantity?: unknown };
    if (typeof name !== 'string') return null;
    const trimmed = name.trim();
    if (!trimmed || seen.has(trimmed)) return null;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) return null;
    seen.add(trimmed);
    items.push({ name: trimmed, quantity });
  }
  return items;
}

/** 單一項目的顯示字串：數量 1 只寫名稱，超過 1 才加「 ×N」。 */
export function formatEquipmentItem(item: EquipmentItem): string {
  return item.quantity > 1 ? `${item.name} ×${item.quantity}` : item.name;
}

/** formatEquipmentItem 的反向解析：「冷氣 ×2」→ 冷氣兩台；沒有數量後綴的視為 1。 */
export function parseEquipmentLabel(label: string): EquipmentItem {
  const matched = /^(.*?)\s*×\s*(\d+)$/.exec(label.trim());
  if (!matched) return { name: label.trim(), quantity: 1 };
  const quantity = Number(matched[2]);
  return { name: matched[1].trim(), quantity: quantity >= 1 ? quantity : 1 };
}

// ── 設備附件（ADR-0008）─────────────────────────────────────────────

/** 修繕責任預設出租方（GLOSSARY.md：呼應內政部範本第八條精神）。 */
export const DEFAULT_REPAIR: RepairResponsibility = 'landlord';

function annexRow(item: EquipmentItem): EquipmentAnnexRow {
  return { name: item.name, quantity: item.quantity, repair: DEFAULT_REPAIR, note: '' };
}

/** 空白的一列，供 wizard 從詞彙庫加列用。 */
export function newAnnexRow(name = ''): EquipmentAnnexRow {
  return { name, quantity: 1, repair: DEFAULT_REPAIR, note: '' };
}

/** 建約帶入：物件的設備清單 → 設備附件列（修繕責任預設出租方、備註空）。 */
export function toEquipmentAnnex(items: EquipmentItem[]): EquipmentAnnexRow[] {
  return items.map(annexRow);
}

/** 把任意值收斂成一列附件；名稱空白回 null，其餘欄位壞掉一律保底。 */
function coerceAnnexRow(value: unknown): EquipmentAnnexRow | null {
  // 舊形狀混進來的「名稱 ×N」字串一樣吃得下
  if (typeof value === 'string') {
    const item = parseEquipmentLabel(value);
    return item.name ? annexRow(item) : null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { name, quantity, repair, note } = value as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim()) return null;
  const n = typeof quantity === 'number' && Number.isFinite(quantity) ? Math.floor(quantity) : 1;
  return {
    name: name.trim(),
    quantity: n >= 1 ? n : 1,
    repair: REPAIR_RESPONSIBILITIES.includes(repair as RepairResponsibility)
      ? (repair as RepairResponsibility)
      : DEFAULT_REPAIR,
    note: typeof note === 'string' ? note : '',
  };
}

/**
 * 讀一份合約的設備附件列。
 * MIL-29 之前的合約沒有 equipmentAnnex，只有壓平成字串的 equipment，這裡轉成附件列
 * （數量從「名稱 ×N」解析回來、修繕責任出租方、備註空），比照 TemplateBinding 的可選欄位慣例。
 */
export function contractEquipmentAnnex(snapshot: EquipmentAnnexSnapshot): EquipmentAnnexRow[] {
  const raw = snapshot.equipmentAnnex ?? snapshot.equipment ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.map(coerceAnnexRow).filter((row): row is EquipmentAnnexRow => row !== null);
}

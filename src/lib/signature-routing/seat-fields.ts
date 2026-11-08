// 簽署區域與簽署席位的對應（ADR-0021 決議 5）。純函式，沒有 I/O。
// 規則與 buildSignerSequence 一致：有 slot 的歸該席位，沒有 slot 的舊資料歸同角色的第一個席位。

import type { SignatureField } from '../types';
import type { SeatView } from './seats';

/**
 * 簽署區域屬於哪個席位。slot 不在序列內時回傳 undefined，不退回角色，
 * 因為 buildSignerSequence 也會丟掉這種區域，檢核要與送簽一致。
 */
export function seatOfField(field: SignatureField, seats: readonly SeatView[]): SeatView | undefined {
  if (field.slot !== undefined) return seats.find((seat) => seat.ruleId === field.slot);
  return seats.find((seat) => seat.role === field.signer);
}

export interface SeatFieldCount {
  seat: SeatView;
  count: number;
}

/** 依簽署序列列出每個席位的簽署區域數。 */
export function countFieldsBySeat(fields: readonly SignatureField[], seats: readonly SeatView[]): SeatFieldCount[] {
  const counts = new Map<string, number>(seats.map((seat) => [seat.ruleId, 0]));
  for (const f of fields) {
    const seat = seatOfField(f, seats);
    if (seat) counts.set(seat.ruleId, (counts.get(seat.ruleId) ?? 0) + 1);
  }
  return seats.map((seat) => ({ seat, count: counts.get(seat.ruleId) ?? 0 }));
}

export interface ReconcileResult {
  fields: SignatureField[];
  /** 因序列已沒有該角色而移除的簽署區域數。 */
  removed: number;
}

/**
 * 分流條件改變後整理簽署區域：
 * - slot 仍在序列內的、角色仍在序列內的舊資料：原樣保留。
 * - slot 已不在序列內但角色還在：改歸該角色的第一個席位，座標不動。
 * - 序列已沒有這個角色：移除。
 */
export function reconcileSignatureFields(fields: readonly SignatureField[], seats: readonly SeatView[]): ReconcileResult {
  const kept: SignatureField[] = [];
  let removed = 0;
  for (const f of fields) {
    if (seatOfField(f, seats)) {
      kept.push(f);
      continue;
    }
    const sameRole = seats.find((seat) => seat.role === f.signer);
    if (f.slot !== undefined && sameRole) {
      kept.push({ ...f, slot: sameRole.ruleId });
    } else {
      removed += 1;
    }
  }
  return { fields: kept, removed };
}

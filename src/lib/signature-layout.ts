// 簽署區互動的純邏輯（規格 §7 五點基線第 1、2、4 點）：預設落點、拖曳吸附與對齊線、
// 出界夾回、甲乙重疊偵測。SignatureFieldEditor 只負責把滑鼠事件換算成比例座標後呼叫這裡。
//
// 座標一律是「相對該頁的比例」，原點左上、y 向下，和 SignatureField 存進資料庫的格式一致。

import {
  BODY_SIZE,
  MARGIN,
  PAGE_H,
  PAGE_W,
  SIGN_STAMP_BLANK,
  signatureBlockLayout,
  statusAnnexStampBaseline,
  type SignatureBlockSeat,
  type SignatureBlockSpot,
} from './pdf-layout';
import type { SignatureField, SignerRole } from './types';

/** 相對頁面的矩形（0..1）。 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ── 預設落點 ───────────────────────────────────────────────────────────────

/** 簽名框預設寬度（PDF points），落在「簽章：」右側時不會超出右邊界。 */
const STAMP_BOX_W = 180;
/** 「簽章：」三個全形字的寬度，加上一點間距就是簽名框的左緣。 */
const STAMP_LABEL_W = BODY_SIZE * 3;
const STAMP_LABEL_GAP = 8;
/** 框頂相對「簽章：」baseline 再往上留的高度（約一個字高）。 */
const STAMP_BOX_RISE = BODY_SIZE;
/** 非簽名頁的備援落點：靠右下，甲上乙下中間留的間距。 */
const FALLBACK_GAP = 16;

/** 同一落點已被佔用時往右下錯開的距離。 */
const STACK_STEP_PT = 12;
export const DEFAULT_FIELD_STACK_STEP = { x: STACK_STEP_PT / PAGE_W, y: STACK_STEP_PT / PAGE_H };
/** 錯開的嘗試上限，避免落點資料異常時無窮迴圈。 */
const STACK_MAX_TRIES = 64;

const EPS = 1e-9;

/** PDF 座標（原點左下、y 為框頂）換成頁面比例（原點左上）。 */
function toRatioRect(left: number, topY: number, width: number, height: number): Rect {
  return { x: left / PAGE_W, y: (PAGE_H - topY) / PAGE_H, w: width / PAGE_W, h: height / PAGE_H };
}

/** 範本簽名頁上一個簽署欄的落點。 */
function stampRect(spot: SignatureBlockSpot): Rect {
  return toRatioRect(
    MARGIN + STAMP_LABEL_W + STAMP_LABEL_GAP,
    spot.stampBaseline + STAMP_BOX_RISE,
    STAMP_BOX_W,
    SIGN_STAMP_BLANK
  );
}

/** 現況確認附件頁頁底簽署欄「簽章：」旁的落點。位置固定，與表格長短無關（pdf-layout.ts 的 statusAnnexStampBaseline）。 */
function annexStampRect(): Rect {
  return toRatioRect(
    MARGIN + STAMP_LABEL_W + STAMP_LABEL_GAP,
    statusAnnexStampBaseline() + STAMP_BOX_RISE,
    STAMP_BOX_W,
    SIGN_STAMP_BLANK
  );
}

/**
 * 不是簽名頁時的備援落點：靠右下角，依印列順序由上而下排，最後一個貼著下緣。
 * 兩方時甲方在上、乙方在下，與 N 列版面之前相同。
 */
function fallbackRect(printIndex: number, count: number): Rect {
  const fromBottom = count - 1 - printIndex;
  const topY = MARGIN + SIGN_STAMP_BLANK * (fromBottom + 1) + FALLBACK_GAP * fromBottom;
  return toRatioRect(PAGE_W - MARGIN - STAMP_BOX_W, topY, STAMP_BOX_W, SIGN_STAMP_BLANK);
}

/** 沒有給簽署序列時的席位：甲方、乙方兩列，與 N 列版面之前相同。 */
const PARTY_ONLY_SEATS: readonly SignatureBlockSeat[] = [{ role: 'party_a' }, { role: 'party_b' }];

/** 現況確認附件頁上，規則列要求簽章的席位（MIL-71）。 */
export interface StatusAnnexTarget {
  /** 附件頁的頁碼（0-based）。 */
  page: number;
  /** 要求在附件頁簽章的席位 rule_id。 */
  slots: readonly string[];
}

export interface DefaultFieldRectInput {
  signer: SignerRole;
  /** 簽署席位（規則列的 rule_id）。沒有時以簽署角色對應該角色的第一個席位。 */
  slot?: string;
  /** 簽署序列的席位。沒有時是甲方、乙方兩列。 */
  seats?: readonly SignatureBlockSeat[];
  /** 要放框的頁碼（0-based）。 */
  page: number;
  /** 範本簽名欄所在的頁碼（0-based）。有設備附件或現況確認附件時不是最後一頁，由 PDF 版面判定（MIL-162）。 */
  signaturePage: number;
  /** 現況確認附件頁與要求在該頁簽章的席位。沒有附件頁時不帶。 */
  statusAnnex?: StatusAnnexTarget;
  /** 目前已有的簽名框，用來避免新框正好疊在舊框上。 */
  existing: SignatureField[];
}

function samePosition(a: Rect, b: Rect): boolean {
  return Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
}

/**
 * 新增簽名框的預設落點：簽名頁落在對應的甲／乙簽名欄旁，現況確認附件頁的指定席位落在頁底簽署欄旁，其他頁用右下角的備援位置。
 * 同一落點已經有框時往右下錯開一格，避免新框整個蓋住舊框。
 */
export function defaultFieldRect(input: DefaultFieldRectInput): Rect {
  const spots = signatureBlockLayout(input.seats ?? PARTY_ONLY_SEATS);
  const found = spots.findIndex((spot) =>
    input.slot !== undefined ? spot.slot === input.slot : spot.role === input.signer
  );
  // 序列裡找不到這個席位時（不該發生）放在最後一列，不讓編輯器壞掉
  const index = found >= 0 ? found : spots.length - 1;
  const onStatusAnnex =
    input.statusAnnex !== undefined &&
    input.page === input.statusAnnex.page &&
    input.slot !== undefined &&
    input.statusAnnex.slots.includes(input.slot);
  const base = onStatusAnnex
    ? annexStampRect()
    : input.page === input.signaturePage
      ? stampRect(spots[index])
      : fallbackRect(index, spots.length);
  const samePage = input.existing.filter((f) => f.page === input.page);
  let candidate = clampRect(base);
  for (let step = 1; step <= STACK_MAX_TRIES; step++) {
    if (!samePage.some((f) => samePosition(f, candidate))) return candidate;
    candidate = clampRect({
      ...base,
      x: base.x + step * DEFAULT_FIELD_STACK_STEP.x,
      y: base.y + step * DEFAULT_FIELD_STACK_STEP.y,
    });
  }
  return candidate;
}

// ── 出界夾回 ───────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 把框夾回頁面範圍內：先把寬高夾到最多滿版，再把左上角推回可放得下的位置。 */
export function clampRect(rect: Rect): Rect {
  const w = clamp(rect.w, 0, 1);
  const h = clamp(rect.h, 0, 1);
  return { x: clamp(rect.x, 0, 1 - w), y: clamp(rect.y, 0, 1 - h), w, h };
}

// ── 吸附與對齊線 ───────────────────────────────────────────────────────────

export type GuideOrientation = 'vertical' | 'horizontal';

/** 要畫在頁面上的一條對齊線；position 是該軸的比例位置。 */
export interface AlignGuide {
  orientation: GuideOrientation;
  position: number;
}

export interface SnapResult {
  x: number;
  y: number;
  guides: AlignGuide[];
}

/** 吸附閾值（螢幕像素）；換算成比例時兩軸各自除以該頁的實際寬高。 */
export const SNAP_THRESHOLD_PX = 6;

/** 把像素閾值換算成兩軸的比例閾值。 */
export function snapThresholdRatio(
  pageSize: { width: number; height: number },
  px: number = SNAP_THRESHOLD_PX
): { x: number; y: number } {
  return { x: px / pageSize.width, y: px / pageSize.height };
}

const PAGE_GUIDES_X = [MARGIN / PAGE_W, 0.5, 1 - MARGIN / PAGE_W];
const PAGE_GUIDES_Y = [MARGIN / PAGE_H, 0.5, 1 - MARGIN / PAGE_H];

/** 某一軸上可以被吸附的位置：同頁其他框的兩邊與中線，加上頁緣邊距與頁面中線。 */
function candidates(others: Rect[], axis: 'x' | 'y'): number[] {
  const size = axis === 'x' ? 'w' : 'h';
  const page = axis === 'x' ? PAGE_GUIDES_X : PAGE_GUIDES_Y;
  const list: number[] = [];
  for (const o of others) list.push(o[axis], o[axis] + o[size] / 2, o[axis] + o[size]);
  list.push(...page);
  return list;
}

/** 拖曳中的框在該軸上的三個對齊點（起邊、中線、末邊）相對左上角的位移。 */
function offsets(size: number): number[] {
  return [0, size / 2, size];
}

function snapAxis(position: number, size: number, cands: number[], threshold: number): number {
  let best = position;
  let bestDelta = Infinity;
  for (const offset of offsets(size)) {
    for (const candidate of cands) {
      const delta = Math.abs(candidate - (position + offset));
      if (delta <= threshold && delta < bestDelta) {
        bestDelta = delta;
        best = candidate - offset;
      }
    }
  }
  return best;
}

function guidesFor(
  position: number,
  size: number,
  cands: number[],
  orientation: GuideOrientation
): AlignGuide[] {
  const hit = new Set<number>();
  for (const offset of offsets(size)) {
    for (const candidate of cands) {
      if (Math.abs(candidate - (position + offset)) < EPS) hit.add(candidate);
    }
  }
  return [...hit].map((p) => ({ orientation, position: p }));
}

/**
 * 拖曳／縮放中的框吸附到同頁其他框與頁緣，回傳吸附後的左上角座標與該畫的對齊線。
 * 吸附後仍會夾回頁面範圍內；被夾回而失去對齊時就不畫線。
 */
export function snapPosition(
  moving: Rect,
  others: Rect[],
  threshold: { x: number; y: number }
): SnapResult {
  const candX = candidates(others, 'x');
  const candY = candidates(others, 'y');
  const snapped = clampRect({
    ...moving,
    x: snapAxis(moving.x, moving.w, candX, threshold.x),
    y: snapAxis(moving.y, moving.h, candY, threshold.y),
  });
  return {
    x: snapped.x,
    y: snapped.y,
    guides: [
      ...guidesFor(snapped.x, snapped.w, candX, 'vertical'),
      ...guidesFor(snapped.y, snapped.h, candY, 'horizontal'),
    ],
  };
}

// ── 重疊警示 ───────────────────────────────────────────────────────────────

/** 兩框是否真的相交；邊貼邊不算重疊。 */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export interface CrossSignerOverlap {
  page: number;
  ids: [string, string];
}

/**
 * 兩個框是否屬於不同的簽署席位：角色不同，或兩邊都有 slot 且 slot 不同。
 * 舊資料沒有 slot，與同角色的新框視為同一席位。
 */
function differentSeat(a: SignatureField, b: SignatureField): boolean {
  if (a.signer !== b.signer) return true;
  return a.slot !== undefined && b.slot !== undefined && a.slot !== b.slot;
}

/** 同一頁上不同簽署席位互相重疊的框；同一席位的框重疊不算（例如刻意疊放的兩個甲方框）。 */
export function crossSignerOverlaps(fields: SignatureField[]): CrossSignerOverlap[] {
  const found: CrossSignerOverlap[] = [];
  for (let i = 0; i < fields.length; i++) {
    for (let j = i + 1; j < fields.length; j++) {
      const a = fields[i];
      const b = fields[j];
      if (a.page !== b.page || !differentSeat(a, b)) continue;
      if (rectsOverlap(a, b)) found.push({ page: a.page, ids: [a.id, b.id] });
    }
  }
  return found;
}

/** 重疊警示文字；沒有重疊回 null。涉及執業人員時不寫「甲乙」。 */
export function overlapWarning(fields: SignatureField[]): string | null {
  const overlaps = crossSignerOverlaps(fields);
  if (overlaps.length === 0) return null;
  const pages = [...new Set(overlaps.map((o) => o.page))].sort((a, b) => a - b);
  const byId = new Map(fields.map((f) => [f.id, f]));
  const partiesOnly = overlaps.every((o) =>
    o.ids.every((id) => {
      const role = byId.get(id)?.signer;
      return role === 'party_a' || role === 'party_b';
    })
  );
  const subject = partiesOnly ? '甲乙簽名框' : '不同簽署席位的簽名框';
  return `第 ${pages.map((p) => p + 1).join('、')} 頁有${subject}重疊，請分開擺放避免簽名蓋到彼此`;
}

/** 重疊警示涉及的框 id，用來在編輯器上把該框標紅。 */
export function overlappingFieldIds(fields: SignatureField[]): Set<string> {
  const ids = new Set<string>();
  for (const o of crossSignerOverlaps(fields)) {
    ids.add(o.ids[0]);
    ids.add(o.ids[1]);
  }
  return ids;
}

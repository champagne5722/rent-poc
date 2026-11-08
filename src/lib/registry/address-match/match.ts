// 疑似重複判定與批次比對純函式（ADR-0025 決議 10，MIL-147）。不碰資料庫。
import { normalizeUnitToken } from './text';

export const DEFAULT_DISTANCE_THRESHOLD_METERS = 15;

export interface Coordinate {
  lat: number;
  lng: number;
}

// 一筆已正規化的登錄。doorplate 是 normalizeAddress 輸出的比對用門牌。
export interface RegistryAddress {
  id?: string;
  countyLetter: string;
  districtCode: string;
  doorplate: string;
  floor?: string | null;
  room?: string | null;
  coordinate?: Coordinate | null;
}

export type DuplicateReason = 'DOORPLATE_SAME' | 'COORDINATE_NEAR';

export interface DuplicateMatchResult {
  suspected: boolean;
  reasons: DuplicateReason[];
}

export interface DuplicateMatchOptions {
  // 座標距離門檻（公尺），預設 15。距離小於等於門檻即命中。
  distanceThresholdMeters?: number;
}

export interface BatchMatch<C extends RegistryAddress> {
  candidate: C;
  reasons: DuplicateReason[];
}

const EARTH_RADIUS_METERS = 6371008.8;

function isValidCoordinate(c: Coordinate | null | undefined): c is Coordinate {
  return (
    c != null &&
    Number.isFinite(c.lat) && Number.isFinite(c.lng) &&
    Math.abs(c.lat) <= 90 && Math.abs(c.lng) <= 180
  );
}

// haversine 公式，回傳兩點的球面距離（公尺）。
export function haversineMeters(a: Coordinate, b: Coordinate): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

// 兩邊相同，或其中一方空白，視為相容。
function compatible(a: string, b: string): boolean {
  return a === '' || b === '' || a === b;
}

export function detectSuspectedDuplicate(
  a: RegistryAddress,
  b: RegistryAddress,
  options: DuplicateMatchOptions = {},
): DuplicateMatchResult {
  const none: DuplicateMatchResult = { suspected: false, reasons: [] };
  if (a.countyLetter.toUpperCase() !== b.countyLetter.toUpperCase()) return none;
  if (a.districtCode !== b.districtCode) return none;

  const reasons: DuplicateReason[] = [];
  if (
    a.doorplate !== '' &&
    a.doorplate === b.doorplate &&
    compatible(normalizeUnitToken(a.floor), normalizeUnitToken(b.floor)) &&
    compatible(normalizeUnitToken(a.room), normalizeUnitToken(b.room))
  ) {
    reasons.push('DOORPLATE_SAME');
  }

  const threshold = options.distanceThresholdMeters ?? DEFAULT_DISTANCE_THRESHOLD_METERS;
  if (
    isValidCoordinate(a.coordinate) &&
    isValidCoordinate(b.coordinate) &&
    haversineMeters(a.coordinate, b.coordinate) <= threshold
  ) {
    reasons.push('COORDINATE_NEAR');
  }

  return { suspected: reasons.length > 0, reasons };
}

// 一筆新登錄對候選清單比對。候選由呼叫端查好傳入。保留候選的輸入順序。
export function findSuspectedDuplicates<C extends RegistryAddress>(
  target: RegistryAddress,
  candidates: readonly C[],
  options: DuplicateMatchOptions = {},
): Array<BatchMatch<C>> {
  const out: Array<BatchMatch<C>> = [];
  for (const candidate of candidates) {
    if (target.id !== undefined && candidate.id === target.id) continue;
    const { suspected, reasons } = detectSuspectedDuplicate(target, candidate, options);
    if (suspected) out.push({ candidate, reasons });
  }
  return out;
}

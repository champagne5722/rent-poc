// 證書快照（ADR-0018 決議 12）：簽章紀錄的 snapshot_at_send 與 snapshot_at_sign 存這個形狀。
// 純函式，沒有 I/O。時間由參數傳入。
//
// 內容：證書種類、遮罩證號、valid_until、三層狀態、三層最新的核對紀錄 ID、判定時點、判定結果。
// 不存身分證字號與地址，也不存證號原文。型別沒有這些欄位，測試鎖定序列化後的內容。

import { credentialStatusAt, type CredentialStatus } from '../credential-status';
import type { CertificateKind } from '../labels';
import type { PractitionerCandidate } from '../practice-registry';
import type { CredentialState } from '../registry-rules';

export interface LayerSnapshot {
  state: CredentialState | null;
  validUntil: string | null;
  /** 判定當下最新的核對紀錄 ID（ADR-0017 決議 10）。 */
  latestCheckId: string | null;
}

export interface EmploymentSnapshot {
  state: CredentialState | null;
  startsOn: string;
  endsOn: string | null;
  latestCheckId: string | null;
}

export interface CredentialSnapshot {
  /** 判定時點，ISO 8601。送簽時是送簽當下，簽署時是簽署事件時間。 */
  decidedAt: string;
  certificateKind: CertificateKind | null;
  /** 只留最後三碼。 */
  certificateNoMasked: string | null;
  /** 證書層的 valid_until（YYYY-MM-DD）。 */
  validUntil: string | null;
  layers: {
    license: LayerSnapshot;
    practitioner: LayerSnapshot;
    employment: EmploymentSnapshot;
  };
  result: CredentialStatus;
}

/** 簽署事件到達時查不到登錄資料。簽署進度照常推進，快照只記錄查不到。 */
export interface UnavailableSnapshot {
  decidedAt: string;
  unavailable: true;
  reason: string;
}

export type SignatureSnapshot = CredentialSnapshot | UnavailableSnapshot;

export function isUnavailableSnapshot(snapshot: SignatureSnapshot): snapshot is UnavailableSnapshot {
  return 'unavailable' in snapshot;
}

const VISIBLE_TAIL = 3;

/** 證號只留最後三碼，其餘以 * 取代。沒有證號回 null。 */
export function maskCertificateNo(certificateNo: string | null): string | null {
  if (!certificateNo) return null;
  const chars = [...certificateNo];
  if (chars.length <= VISIBLE_TAIL) return '*'.repeat(chars.length);
  return '*'.repeat(chars.length - VISIBLE_TAIL) + chars.slice(-VISIBLE_TAIL).join('');
}

/** @param at 判定時點，ISO 8601。 */
export function buildCredentialSnapshot(candidate: PractitionerCandidate, at: string): CredentialSnapshot {
  const { license, practitioner, employment } = candidate.credential;
  return {
    decidedAt: at,
    certificateKind: candidate.certificateKind,
    certificateNoMasked: maskCertificateNo(candidate.certificateNo),
    validUntil: practitioner.validUntil,
    layers: {
      license: { state: license.state, validUntil: license.validUntil, latestCheckId: license.latestCheckId },
      practitioner: {
        state: practitioner.state,
        validUntil: practitioner.validUntil,
        latestCheckId: practitioner.latestCheckId,
      },
      employment: {
        state: employment.state,
        startsOn: employment.startsOn,
        endsOn: employment.endsOn,
        latestCheckId: employment.latestCheckId,
      },
    },
    result: credentialStatusAt(candidate.credential, at),
  };
}

export function unavailableSnapshot(at: string, reason: string): UnavailableSnapshot {
  return { decidedAt: at, unavailable: true, reason };
}

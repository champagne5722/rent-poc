import type { OrgTx } from '../pg/with-tx';
import { certificateBadge, type CertificateBadge, type CertificateKind, type CredentialState } from '../registry-rules';
import type { CertificateNumber } from './rules';

// 給其他線的查詢（MIL-111）。兩個函式都是資料庫定義者函式的薄包裝，不寫入。

// ---------------------------------------------------------------------------
// 可簽章判定事實（給 MIL-113 的 practiceRegistry 真實 adapter）

export interface LicenseFact {
  kind: 'management' | 'master_lease' | 'brokerage';
  state: CredentialState;
  lastCheckId: string | null;
}

/**
 * 一位人員在一個執業主體的簽章事實。「可簽章」本身由 D 線的 credentialStatusAt 判定（ADR-0017 決議 6）：
 * 對應業別、證書、任職三層都是 verified，任職期間涵蓋查詢時點，查詢時點不晚於 validUntil。
 * 證號是遮罩前的三段，adapter 負責遮罩。
 */
export interface PractitionerSigningFact {
  partyId: string;
  employmentId: string;
  practitionerId: string;
  certificateKind: CertificateKind;
  certificateNo: CertificateNumber;
  practitionerState: CredentialState;
  /** 證書效期，YYYY-MM-DD。 */
  validUntil: string;
  practitionerLastCheckId: string | null;
  employmentState: CredentialState;
  employmentStartedOn: string;
  employmentEndedOn: string | null;
  employmentLastCheckId: string | null;
  consentRequired: boolean;
  consentedByEntity: boolean;
  consentValidUntil: string | null;
}

export interface SigningFacts {
  licenses: LicenseFact[];
  practitioners: PractitionerSigningFact[];
}

interface RawFacts {
  licenses: Array<{ kind: LicenseFact['kind']; state: CredentialState; last_check_id: string | null }>;
  practitioners: Array<{
    party_id: string; employment_id: string; practitioner_id: string; certificate_kind: CertificateKind;
    certificate_no: { year: string; word: string; serial: string }; practitioner_state: CredentialState; valid_until: string;
    practitioner_last_check_id: string | null; employment_state: CredentialState; employment_started_on: string;
    employment_ended_on: string | null; employment_last_check_id: string | null; consent_required: boolean;
    consented_by_entity: boolean; consent_valid_until: string | null;
  }>;
}

/**
 * 查執業主體與指定人員的簽章事實。只允許該執業主體自己的組織與平台營運者呼叫（回傳未遮罩證號）。
 * 其他組織呼叫，或執業主體不存在，回傳空的事實，兩者不可區分（ADR-0012 決議 8）。
 * 每位人員每種證書回傳最新的一筆任職，已驗證的優先。
 */
export async function getSigningFacts(tx: OrgTx, entityId: string, partyIds: readonly string[]): Promise<SigningFacts> {
  const { rows } = await tx.query<{ facts: RawFacts }>('SELECT registry.signing_facts($1, $2::text[]) AS facts', [entityId, [...partyIds]]);
  const raw = rows[0].facts;
  return {
    licenses: raw.licenses.map((l) => ({ kind: l.kind, state: l.state, lastCheckId: l.last_check_id })),
    practitioners: raw.practitioners.map((p) => ({
      partyId: p.party_id,
      employmentId: p.employment_id,
      practitionerId: p.practitioner_id,
      certificateKind: p.certificate_kind,
      certificateNo: { year: p.certificate_no.year, word: p.certificate_no.word, serial: p.certificate_no.serial },
      practitionerState: p.practitioner_state,
      validUntil: p.valid_until,
      practitionerLastCheckId: p.practitioner_last_check_id,
      employmentState: p.employment_state,
      employmentStartedOn: p.employment_started_on,
      employmentEndedOn: p.employment_ended_on,
      employmentLastCheckId: p.employment_last_check_id,
      consentRequired: p.consent_required,
      consentedByEntity: p.consented_by_entity,
      consentValidUntil: p.consent_valid_until,
    })),
  };
}

// ---------------------------------------------------------------------------
// 標章（給 F 線 MIL-102 與案件頁）

export interface PractitionerBadge {
  partyId: string;
  certificateKind: CertificateKind;
  /** 固定文字「證書資料已核對」加核對日，取自 certificateBadge()。 */
  badge: CertificateBadge;
}

/**
 * 證書層已驗證的人員才有標章。任何組織脈絡都能呼叫，只回 party ID、證書種類與核對日，
 * 不回證號與任何組織資料。沒有標章的人員不在結果裡（沒登錄、待驗證、已失效不可區分）。
 */
export async function getCertificateBadges(tx: OrgTx, partyIds: readonly string[]): Promise<PractitionerBadge[]> {
  if (partyIds.length === 0) return [];
  const { rows } = await tx.query<{ party_id: string; certificate_kind: CertificateKind; checked_on: string | null }>(
    'SELECT * FROM registry.certificate_badges($1::text[])',
    [[...partyIds]],
  );
  return rows
    .filter((r): r is typeof r & { checked_on: string } => r.checked_on !== null)
    .map((r) => ({ partyId: r.party_id, certificateKind: r.certificate_kind, badge: certificateBadge(r.checked_on) }));
}

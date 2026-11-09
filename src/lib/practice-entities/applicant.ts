import { appendAudit } from '../audit';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import {
  checkLicenseEligibility,
  decideCredentialTransition,
  type CredentialState,
  type EntityType,
  type LicenseKind,
} from '../registry-rules';
import { registerEvidence, type StoredEvidence } from './evidence';

// 執業主體端（MIL-109）：看自己的登錄進度，送出業別、證字號與證據檔。組織脈絡。
// 登錄者與第二個組織認領同一統編的認領方，回應形狀與欄位完全相同（ADR-0012 決議 8），
// 這個檔案沒有任何地方區分兩者。

/** 業別在執業主體端看到的進度。 */
export type LicensePhase = 'not_submitted' | 'awaiting_review' | 'needs_resubmission' | 'verified' | 'lapsed';

export interface MyLicense {
  kind: LicenseKind;
  state: CredentialState;
  permitNo: string | null;
  phase: LicensePhase;
  /** 最新一筆核對的結果。尚未核對為 null。 */
  lastResult: 'match' | 'mismatch' | 'not_found' | 'revoked' | null;
  /** 營運者的判定理由，執業主體據此補件。最新一筆是相符時為 null。 */
  lastNote: string | null;
  lastCheckedAt: string | null;
  submittedAt: string | null;
}

export interface MyRegistration {
  taxId: string;
  name: string;
  entityType: EntityType;
  licenses: MyLicense[];
}

interface RegistrationRow {
  tax_id: string;
  name: string;
  entity_type: EntityType;
  kind: LicenseKind;
  state: CredentialState;
  permit_no: string | null;
  phase: LicensePhase;
  last_result: MyLicense['lastResult'];
  last_note: string | null;
  last_checked_at: Date | string | null;
  submitted_at: Date | string | null;
}

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

/** 目前組織的登錄。沒有登錄（例如擁有者組織）回 null。 */
export async function getMyRegistration(tx: OrgTx): Promise<MyRegistration | null> {
  const { rows } = await tx.query<RegistrationRow>('SELECT * FROM registry.my_registration()');
  if (rows.length === 0) return null;
  return {
    taxId: rows[0].tax_id,
    name: rows[0].name,
    entityType: rows[0].entity_type,
    licenses: rows.map((r) => ({
      kind: r.kind,
      state: r.state,
      permitNo: r.permit_no,
      phase: r.phase,
      lastResult: r.last_result,
      lastNote: r.last_note,
      lastCheckedAt: iso(r.last_checked_at),
      submittedAt: iso(r.submitted_at),
    })),
  };
}

export interface SubmitInput {
  userId: string;
  kind: LicenseKind;
  permitNo: string;
  /** 已經寫進 FileStore 的證據檔。 */
  files: readonly StoredEvidence[];
}

export type SubmitResult =
  | { status: 'submitted'; kind: LicenseKind; from: CredentialState | null }
  | { status: 'not_registered' }
  | { status: 'already_verified' }
  | { status: 'company_required'; message: string };

/**
 * 送出一個業別。狀態轉移用 decideCredentialTransition：沒有這個業別是 submitted，待驗證或已失效是 resubmitted。
 * 已驗證的業別不接受送件。資料庫函式在狀態已被別的請求改掉時丟 SQLSTATE 40001，呼叫端（flows.ts）轉成衝突。
 */
export async function submitLicense(tx: OrgTx, input: SubmitInput): Promise<SubmitResult> {
  const registration = await getMyRegistration(tx);
  if (!registration) return { status: 'not_registered' };

  // 代管與包租限公司（P0-03 AC3）。營業項目要等營運者登錄才有，所以這裡只看組織型態
  const eligibility = checkLicenseEligibility({ kind: input.kind, entityType: registration.entityType, businessItemCodes: [] });
  if (!eligibility.ok) {
    const company = eligibility.reasons.find((r) => r.code === 'company_required');
    if (company) return { status: 'company_required', message: company.message };
  }

  const existing = registration.licenses.find((l) => l.kind === input.kind) ?? null;
  const from = existing?.state ?? null;
  const transition = decideCredentialTransition(from, {
    layer: 'license',
    event: from === null ? { type: 'submitted', requiredFieldsComplete: input.permitNo !== '' && input.files.length > 0 } : { type: 'resubmitted' },
  });
  if (!transition) return { status: 'already_verified' };

  const licenseId = newUlid();
  const itemId = newUlid();
  const { rows } = await tx.query<{ subject_type: 'license' | 'claim'; subject_id: string; item_id: string }>(
    'SELECT * FROM registry.submit_license($1, $2, $3, $4, $5, $6)',
    [input.kind, input.permitNo, licenseId, itemId, from, transition.to],
  );
  const target = rows[0];

  await registerEvidence(tx, {
    subjectType: target.subject_type,
    subjectId: target.subject_id,
    kind: input.kind,
    uploadedBy: input.userId,
    files: input.files,
  });
  // 兩條路徑的事件相同：稽核匯出不得讓認領方看出自己是認領方
  await appendAudit(tx, {
    action: 'practice_entity.submit',
    object: { type: 'license_kind', id: input.kind },
    payload: { kind: input.kind, from, to: transition.to, files: input.files.length },
  });
  return { status: 'submitted', kind: input.kind, from };
}

/** SQLSTATE 40001：資料庫函式發現狀態已被別的請求改掉。 */
export function isStateConflict(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === '40001';
}

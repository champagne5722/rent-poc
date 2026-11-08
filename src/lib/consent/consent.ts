import { appendAudit, type AuditRef } from '../audit';
import { isUlid, newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import {
  NOTICE_CATALOG,
  NOTICE_TYPES,
  currentNotice,
  findNotice,
  textSha256,
  type NoticeCatalog,
  type NoticeType,
} from './notices';

// 告知與同意紀錄（PRD P0-24，MIL-84）。其他 spec 線只從這裡（./index.ts）呼叫。
//
// 規則（介面的一部分）：
// - 兩個函式必須在 withTx 的 callback 內呼叫，用呼叫端自己的 tx。只收 org 與 operator 脈絡（OrgTx）。
//   同意紀錄屬於 tx 的組織（org_id 由資料庫讀 app.org_id 寫入，沒有參數可以指定）。
//   組織歸屬待法務確認（MIL-62 第 10 題）。
// - recordConsent 先寫稽核事件（consent.record），再寫同意紀錄，兩者在同一個交易。
//   交易回滾時兩者都不留下。呼叫端必須把後續步驟（例如送簽）放在同一個 withTx，失敗就一起回滾。
// - 紀錄只增不改。更改決定一律再記一筆新的，latestConsent 取最後寫入的一筆。
//   後寫入的紀錄即使版本較舊（例如對象回應的是寄出時的舊版連結），仍是最新決定，isCurrentVersion 會是 false。
// - party ID 與 email 不會自動串成同一個對象。紀錄只存呼叫端給的識別，查詢時 partyId 或 email 任一相符即算。
//   只用 email 記錄的同意，之後只用 partyId 查詢會查不到。呼叫端查詢時，手上有哪個識別就都帶上。
// - 稽核事件的 payload 不放 email 與 party ID（稽核紀錄寫入後刪不掉，ADR-0019 決議 5）。
// - 紀錄存文字的 SHA-256 與版本號，不存文字本身。文字改版後，舊版仍留在 NOTICE_CATALOG，
//   用版本號還原。

export const CONSENT_DECISIONS = ['agree', 'object'] as const;
export type ConsentDecision = (typeof CONSENT_DECISIONS)[number];

/** in_app 登入後畫面。email_link 免登入回應頁。staff_recorded 人員代為登錄（例如紙本）。 */
export const CONSENT_SOURCES = ['in_app', 'email_link', 'staff_recorded'] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

/** 同意的對象。party ID 與 email 至少必須有一個。沒有帳號的承租人只有 email。 */
export interface ConsentSubject {
  partyId?: string;
  email?: string;
}

/** 關聯標的：合約、簽署任務、案件、謄本等。類型為小寫英數與底線，不設白名單。 */
export interface RelatedObject {
  type: string;
  id: string;
}

export interface RecordConsentInput {
  notice: NoticeType;
  /** 對象看到的版本。沒填就用目前版本。寄出舊版連結後才回應的對象，要帶寄出時的版本。 */
  version?: number;
  subject: ConsentSubject;
  decision: ConsentDecision;
  source: ConsentSource;
  relatedTo?: RelatedObject;
}

export interface ConsentRecord {
  id: string;
  orgId: string;
  noticeType: NoticeType;
  noticeVersion: number;
  textSha256: string;
  /** 已正規化：email 小寫、去前後空白。 */
  subject: ConsentSubject;
  decision: ConsentDecision;
  source: ConsentSource;
  relatedTo?: RelatedObject;
  /** 同交易寫入的稽核事件位置。 */
  audit: Pick<AuditRef, 'chainId' | 'seq'>;
  recordedAt: Date;
}

export interface LatestConsent extends ConsentRecord {
  /** 這筆紀錄的版本是不是告知目前的版本。false 表示文字改版後，對象還沒對新版表態。 */
  isCurrentVersion: boolean;
}

export interface LatestConsentQuery {
  notice: NoticeType;
  /** partyId 或 email 任一相符，就算同一個對象。 */
  subject: ConsentSubject;
  /** 有指定時，只看該標的的紀錄。 */
  relatedTo?: RelatedObject;
}

// ---------------------------------------------------------------------------
// 輸入檢查

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+$/;
const TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const NO_SUBJECT = '同意對象必須有 party ID 或 email';

function normalizeSubject(subject: ConsentSubject | undefined): { partyId?: string; email?: string } {
  const partyId = subject?.partyId?.trim() || undefined;
  const email = subject?.email?.trim().toLowerCase() || undefined;
  if (partyId === undefined && email === undefined) throw new Error(NO_SUBJECT);
  if (partyId !== undefined && !isUlid(partyId)) throw new Error('同意對象的 party ID 不是合法的 ULID');
  if (email !== undefined && (email.length > 254 || !EMAIL_PATTERN.test(email))) throw new Error('同意對象的 email 格式不合法');
  return { partyId, email };
}

function normalizeRelated(related: RelatedObject | undefined): RelatedObject | undefined {
  if (related === undefined) return undefined;
  if (typeof related.type !== 'string' || !TYPE_PATTERN.test(related.type)) {
    throw new Error('關聯標的的類型必須是小寫英數與底線，64 字內');
  }
  if (typeof related.id !== 'string' || related.id === '' || related.id.length > 64) {
    throw new Error('關聯標的的 ID 不得為空，且在 64 字內');
  }
  return related;
}

function requireNoticeType(type: unknown): NoticeType {
  if (!(NOTICE_TYPES as readonly unknown[]).includes(type)) throw new Error(`不認得的告知類型：${String(type)}`);
  return type as NoticeType;
}

function requireOrgTx(tx: { kind: string }): void {
  if (tx.kind !== 'org' && tx.kind !== 'operator') {
    throw new Error(`同意紀錄只能在組織脈絡（org 或 operator）內讀寫，目前是 ${tx.kind}`);
  }
}

// ---------------------------------------------------------------------------
// 資料列對應

interface ConsentRow {
  id: string;
  org_id: string;
  notice_type: string;
  notice_version: number;
  text_sha256: string;
  subject_party_id: string | null;
  subject_email: string | null;
  decision: string;
  source: string;
  related_type: string | null;
  related_id: string | null;
  audit_chain_id: string;
  audit_seq: string; // bigint 在 pg 回傳字串
  recorded_at: Date | string;
}

const COLUMNS = `id, org_id, notice_type, notice_version, text_sha256, subject_party_id, subject_email,
  decision, source, related_type, related_id, audit_chain_id, audit_seq::text AS audit_seq, recorded_at`;

function toRecord(row: ConsentRow): ConsentRecord {
  const seq = Number(row.audit_seq);
  if (!Number.isSafeInteger(seq)) throw new Error(`稽核序號超出安全整數範圍：${row.audit_seq}`);
  return {
    id: row.id,
    orgId: row.org_id,
    noticeType: row.notice_type as NoticeType,
    noticeVersion: row.notice_version,
    textSha256: row.text_sha256,
    subject: {
      ...(row.subject_party_id !== null ? { partyId: row.subject_party_id } : {}),
      ...(row.subject_email !== null ? { email: row.subject_email } : {}),
    },
    decision: row.decision as ConsentDecision,
    source: row.source as ConsentSource,
    ...(row.related_type !== null && row.related_id !== null ? { relatedTo: { type: row.related_type, id: row.related_id } } : {}),
    audit: { chainId: row.audit_chain_id, seq },
    recordedAt: row.recorded_at instanceof Date ? row.recorded_at : new Date(row.recorded_at),
  };
}

// ---------------------------------------------------------------------------
// 模組

export interface ConsentApi {
  recordConsent(tx: OrgTx, input: RecordConsentInput): Promise<ConsentRecord>;
  latestConsent(tx: OrgTx, query: LatestConsentQuery): Promise<LatestConsent | null>;
}

export interface ConsentDeps {
  /** 測試用：固定主鍵。 */
  newId?: () => string;
}

/** 用指定的告知清單建立模組。正式程式用下面匯出的 recordConsent 與 latestConsent，測試用它模擬文字改版。 */
export function createConsentApi(catalog: NoticeCatalog, deps: ConsentDeps = {}): ConsentApi {
  const newId = deps.newId ?? (() => newUlid());

  async function recordConsent(tx: OrgTx, input: RecordConsentInput): Promise<ConsentRecord> {
    requireOrgTx(tx);
    const noticeType = requireNoticeType(input.notice);
    if (!(CONSENT_DECISIONS as readonly unknown[]).includes(input.decision)) throw new Error(`不認得的決定：${String(input.decision)}`);
    if (!(CONSENT_SOURCES as readonly unknown[]).includes(input.source)) throw new Error(`不認得的來源：${String(input.source)}`);
    const notice =
      input.version === undefined
        ? currentNotice(catalog, noticeType)
        : Number.isInteger(input.version)
          ? findNotice(catalog, noticeType, input.version)
          : undefined;
    if (notice === undefined) throw new Error(`告知 ${noticeType} 沒有版本 ${String(input.version)}`);
    const subject = normalizeSubject(input.subject);
    const related = normalizeRelated(input.relatedTo);

    const id = newId();
    const sha = textSha256(notice.text);

    // 先寫稽核事件取得位置，再寫同意紀錄。同一個交易，任一步失敗兩者都回滾。
    const audit = await appendAudit(tx, {
      action: 'consent.record',
      object: { type: 'consent_record', id },
      payload: {
        notice_type: noticeType,
        notice_version: notice.version,
        text_sha256: sha,
        decision: input.decision,
        source: input.source,
      },
    });

    // org_id 由資料庫讀交易的 app.org_id，呼叫端不能指定
    const { rows } = await tx.query<ConsentRow>(
      `INSERT INTO org.consent_records
         (id, org_id, notice_type, notice_version, text_sha256, subject_party_id, subject_email,
          decision, source, related_type, related_id, audit_chain_id, audit_seq)
       VALUES ($1, nullif(current_setting('app.org_id', true), ''), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${COLUMNS}`,
      [
        id,
        noticeType,
        notice.version,
        sha,
        subject.partyId ?? null,
        subject.email ?? null,
        input.decision,
        input.source,
        related?.type ?? null,
        related?.id ?? null,
        audit.chainId,
        audit.seq,
      ],
    );
    return toRecord(rows[0]);
  }

  async function latestConsent(tx: OrgTx, query: LatestConsentQuery): Promise<LatestConsent | null> {
    requireOrgTx(tx);
    const noticeType = requireNoticeType(query.notice);
    const subject = normalizeSubject(query.subject);
    const related = normalizeRelated(query.relatedTo);
    const { rows } = await tx.query<ConsentRow>(
      `SELECT ${COLUMNS} FROM org.consent_records
        WHERE notice_type = $1
          AND (subject_party_id = $2::text OR subject_email = $3::text)
          AND ($4::text IS NULL OR (related_type = $4::text AND related_id = $5::text))
        ORDER BY seq DESC
        LIMIT 1`,
      [noticeType, subject.partyId ?? null, subject.email ?? null, related?.type ?? null, related?.id ?? null],
    );
    if (rows.length === 0) return null;
    const record = toRecord(rows[0]);
    return { ...record, isCurrentVersion: record.noticeVersion === currentNotice(catalog, noticeType).version };
  }

  return { recordConsent, latestConsent };
}

const defaultApi = createConsentApi(NOTICE_CATALOG);

/** 記錄對象對某版告知的同意或反對。同交易寫稽核事件。 */
export const recordConsent = defaultApi.recordConsent;
/** 該對象對該告知類型的最新決定與版本。沒有紀錄回傳 null。 */
export const latestConsent = defaultApi.latestConsent;

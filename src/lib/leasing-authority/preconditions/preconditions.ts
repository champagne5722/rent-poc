// 出租權源的送簽前提（MIL-150 先做範圍、ADR-0026 決議 10、MIL-42 Q2 補充規則 1、2）。
// 純函式：輸入權源與錨點事實，輸出擋下原因與給告知文字用的事實。不讀資料庫，不讀時間。
//
// 與 D 線 `checkSendPreconditions`（MIL-69、ADR-0018 決議 10）的對接方式：
//
// 1. D 線在送簽前組出 `LeasingAuthoritySendFacts`。資料來源是 B 線的權源與錨點讀取方法
//    （MIL-149、MIL-144 完成後提供）。本模組不負責讀取。
// 2. D 線呼叫 `checkLeasingAuthorityPreconditions(facts)`。
// 3. `reasons` 的每一項都是 `{ code, message }`，與 D 線其他原因同形。D 線把它們接在
//    自己的原因清單後面，全部列給使用者。代碼前綴不重疊，所以不需要改名。
// 4. `facts` 不擋送簽。D 線產生電子簽署告知時，若有 `leasing_authority_unverified`，
//    告知必須載明 `text`（「出租權源未驗證」），並記錄時間與告知版本（MIL-42 Q2 補充規則 1）。
//    告知文字與記錄屬 D 線，本模組只交事實。
//
//   const authority = checkLeasingAuthorityPreconditions(authorityFacts);
//   const reasons = [...practitionerReasons, ...authority.reasons];
//   const noticeFacts = authority.facts; // 交給電子簽署告知
//   if (reasons.length > 0) return { ok: false, reasons };
//
// 不列入送簽前提：謄本新鮮度（ADR-0026 決議 14）、疑似重複（ADR-0025 決議 10、P0-07 AC6）。

/** ADR-0026 決議 1 的三種出租權源。 */
export type LeasingAuthorityKind = 'ownership' | 'authorization' | 'sublease_consent';

/** ADR-0026 決議 2 的四種狀態。 */
export type LeasingAuthorityStatus = 'pending_verification' | 'verified' | 'failed' | 'lapsed';

/** 使用者上傳或填寫的文件。 */
export type LeasingAuthorityDocument =
  | 'registry_transcript'
  | 'transcript_obtained_at'
  | 'authorization_letter'
  | 'sublease_consent_letter';

/** 謄本有信託登記時必須填的四項資料（ADR-0026 決議 1）。 */
export type TrustItem =
  | 'trust_registered_owner'
  | 'trust_parties'
  | 'trust_registration_status'
  | 'trust_leasing_power_clause';

/** 必要文件的全部項目。`registered_upstream` 由上游清單推導，不是上傳的檔案。 */
export type RequiredDocument = LeasingAuthorityDocument | TrustItem | 'registered_upstream';

export type TrustFacts = { registered: false } | { registered: true; providedItems: TrustItem[] };

/** 鏈條上的一個上游節點。 */
export interface UpstreamAuthorityFacts {
  id: string;
  kind: Exclude<LeasingAuthorityKind, 'sublease_consent'>;
  status: LeasingAuthorityStatus;
}

interface AuthorityBase {
  id: string;
  status: LeasingAuthorityStatus;
  providedDocuments: LeasingAuthorityDocument[];
}

/** 租賃單位的主要出租權源。種類決定有哪些欄位：所有權是鏈條的根，沒有上游。 */
export type PrimaryLeasingAuthorityFacts =
  | (AuthorityBase & { kind: 'ownership'; trust: TrustFacts })
  | (AuthorityBase & { kind: 'authorization'; upstream: UpstreamAuthorityFacts[] })
  | (AuthorityBase & {
      kind: 'sublease_consent';
      upstream: UpstreamAuthorityFacts[];
      /** 出租人是 H706021 已驗證的執業主體。C 線完成前由 `practiceRegistry` 判定。 */
      lessorIsVerifiedPracticeEntity: boolean;
    });

export interface LeasingAuthoritySendFacts {
  rentalUnitId: string;
  primaryAuthority: PrimaryLeasingAuthorityFacts | null;
  /**
   * 租賃單位所屬的物件還沒通過平台的文件核對（ADR-0028 決議 5）。
   * 由文件核對的結果決定，不得由鍵是否重複決定：送簽的結果不能讓使用者分辨別的組織是否登錄過同一個鍵。
   */
  propertyNotVerified: boolean;
  /** 疑似重複待審。不擋送簽，也不得顯示給使用者（ADR-0025 決議 10）。 */
  hasPendingSuspectedDuplicate: boolean;
}

export type LeasingAuthorityBlockCode =
  | 'no_primary_authority'
  | 'primary_authority_failed'
  | 'primary_authority_lapsed'
  | 'missing_documents'
  | 'upstream_not_verified'
  | 'lessor_not_verified_practice_entity'
  | 'property_not_verified';

export interface LeasingAuthorityBlockReason {
  code: LeasingAuthorityBlockCode;
  message: string;
  /** 只在 `missing_documents` 出現。 */
  missingDocuments?: RequiredDocument[];
  /** 只在 `upstream_not_verified` 出現。 */
  upstreamAuthorityIds?: string[];
}

export const UNVERIFIED_AUTHORITY_TEXT = '出租權源未驗證';

export interface LeasingAuthoritySendFact {
  code: 'leasing_authority_unverified';
  text: typeof UNVERIFIED_AUTHORITY_TEXT;
  authorityId: string;
}

export interface LeasingAuthorityPreconditionResult {
  blocked: boolean;
  reasons: LeasingAuthorityBlockReason[];
  facts: LeasingAuthoritySendFact[];
}

export const REQUIRED_DOCUMENT_LABELS: Record<RequiredDocument, string> = {
  registry_transcript: '第二類謄本',
  transcript_obtained_at: '謄本取得時間',
  authorization_letter: '授權書',
  sublease_consent_letter: '轉租同意書',
  registered_upstream: '已登錄的上游出租權源',
  trust_registered_owner: '信託的登記所有權人',
  trust_parties: '信託關係人',
  trust_registration_status: '信託登記狀態',
  trust_leasing_power_clause: '出租權限條款',
};

const TRUST_ITEMS: TrustItem[] = [
  'trust_registered_owner',
  'trust_parties',
  'trust_registration_status',
  'trust_leasing_power_clause',
];

/** ADR-0026 決議 6 的必要文件，依固定順序。 */
export function requiredDocumentsFor(kind: LeasingAuthorityKind, trustRegistered: boolean): RequiredDocument[] {
  switch (kind) {
    case 'ownership':
      return ['registry_transcript', 'transcript_obtained_at', ...(trustRegistered ? TRUST_ITEMS : [])];
    case 'authorization':
      return ['authorization_letter', 'registered_upstream'];
    case 'sublease_consent':
      return ['sublease_consent_letter', 'registered_upstream'];
  }
}

function missingDocumentsOf(authority: PrimaryLeasingAuthorityFacts): RequiredDocument[] {
  const provided = new Set<RequiredDocument>(authority.providedDocuments);
  if (authority.kind === 'ownership') {
    if (authority.trust.registered) for (const item of authority.trust.providedItems) provided.add(item);
  } else if (authority.upstream.length > 0) {
    provided.add('registered_upstream');
  }
  const trustRegistered = authority.kind === 'ownership' && authority.trust.registered;
  return requiredDocumentsFor(authority.kind, trustRegistered).filter((doc) => !provided.has(doc));
}

function reason(
  code: LeasingAuthorityBlockCode,
  message: string,
  extra: Partial<LeasingAuthorityBlockReason> = {},
): LeasingAuthorityBlockReason {
  return { code, message, ...extra };
}

/**
 * 原因依固定順序排列：權源本身、文件、鏈條、出租人資格、物件核對。
 * 多項同時成立時全部列出，讓使用者一次補正。
 */
export function checkLeasingAuthorityPreconditions(
  facts: LeasingAuthoritySendFacts,
): LeasingAuthorityPreconditionResult {
  const reasons: LeasingAuthorityBlockReason[] = [];
  const sendFacts: LeasingAuthoritySendFact[] = [];
  const authority = facts.primaryAuthority;

  if (authority === null) {
    reasons.push(reason('no_primary_authority', '這個租賃單位沒有主要出租權源。請先登錄出租權源再送簽。'));
  } else {
    if (authority.status === 'failed') {
      reasons.push(
        reason('primary_authority_failed', '主要出租權源驗證失敗，平台比對文件不符。請補件後重新送審。'),
      );
    } else if (authority.status === 'lapsed') {
      reasons.push(reason('primary_authority_lapsed', '主要出租權源已失效。請登錄新的出租權源再送簽。'));
    } else if (authority.status === 'pending_verification') {
      sendFacts.push({
        code: 'leasing_authority_unverified',
        text: UNVERIFIED_AUTHORITY_TEXT,
        authorityId: authority.id,
      });
    }

    const missing = missingDocumentsOf(authority);
    if (missing.length > 0) {
      const labels = missing.map((doc) => REQUIRED_DOCUMENT_LABELS[doc]).join('、');
      reasons.push(
        reason('missing_documents', `出租權源的必要文件未齊，缺少：${labels}。`, { missingDocuments: missing }),
      );
    }

    if (authority.kind !== 'ownership') {
      const notVerified = authority.upstream.filter((node) => node.status !== 'verified').map((node) => node.id);
      if (notVerified.length > 0) {
        reasons.push(
          reason('upstream_not_verified', '出租權源的上游不是已驗證。上游驗證完成後才能送簽。', {
            upstreamAuthorityIds: notVerified,
          }),
        );
      }
    }

    if (authority.kind === 'sublease_consent' && !authority.lessorIsVerifiedPracticeEntity) {
      reasons.push(
        reason(
          'lessor_not_verified_practice_entity',
          '轉租同意的出租人必須是已驗證的包租業執業主體。請先完成業別驗證。',
        ),
      );
    }
  }

  if (facts.propertyNotVerified) {
    reasons.push(reason('property_not_verified', '物件尚未通過平台的文件核對。通過後才能送簽。'));
  }

  // 疑似重複待審不擋送簽，也不得出現在原因或事實裡（ADR-0025 決議 10）

  return { blocked: reasons.length > 0, reasons, facts: sendFacts };
}

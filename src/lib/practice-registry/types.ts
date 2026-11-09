// 全域登錄 seam：practiceRegistry（ADR-0021 決議 3，ADR-0018 決議 2、10）。
// 回傳執業主體、當事人簽署人候選、執業人員候選與可簽章的判定事實。
// 第一版 adapter 是 seed 假資料，只用於 mock 與 sandbox。C 線的 MIL-113 提供真實 adapter，換掉 adapter 即可，呼叫端不改。
//
// 介面一律回傳 Promise。ID 一律 string，A 線遷移與 C 線的資料表不必配合數字 ID。
// 不開放手動輸入：執業人員的姓名與 email 只能來自這裡（ADR-0018 決議 10 第 6 項）。

import type { CredentialFacts } from '../credential-status';
import type { CertificateKind, LicenseKind } from '../labels';

/** 執業主體：持有許可或登記的公司或商號，是合約當事人（GLOSSARY「執業主體」）。 */
export interface PracticeEntity {
  id: string;
  name: string;
  /** 已登錄的業別。判定是否已驗證看判定事實，不看這裡。 */
  licenseKinds: readonly LicenseKind[];
}

/** 當事人簽署人候選：執業主體指派、代表當事人簽署的自然人，必須是該組織的成員（ADR-0018 決議 2）。 */
export interface PartySignerCandidate {
  id: string;
  /**
   * 自然人的 party ID。同一個人以當事人簽署人與執業人員兩種身分出現時，兩邊的 partyId 相同。
   * 簽署序列的合併靠它判定（ADR-0018 決議 9，MIL-76）。
   */
  partyId: string;
  entityId: string;
  name: string;
  email: string;
}

/**
 * 執業人員候選與可簽章的判定事實。
 * `certificateKind` 是 null 代表沒有證書（例如負責人沒有管理人員證書，P0-12 AC5）。
 * `accountEmail` 是執業人員帳號的 email，簽署人的 email 一律取自這裡。
 */
export interface PractitionerCandidate {
  id: string;
  /** 自然人的 party ID，與同一個人的當事人簽署人候選相同（MIL-76）。 */
  partyId: string;
  name: string;
  accountEmail: string;
  certificateKind: CertificateKind | null;
  /** 專任旗標（P0-12 AC4）。 */
  fullTime: boolean;
  /** 是否為執業主體的負責人。只用於說明原因。 */
  isResponsiblePerson: boolean;
  /** 任職所屬的執業主體。 */
  entityId: string;
  /** 任職的 ID。簽章紀錄存它（ADR-0018 決議 12）。 */
  employmentId: string;
  /**
   * 證書號碼原文，沒有證書時為 null。只在登錄與送簽判定之間流動，
   * 簽章紀錄的快照只存遮罩後的證號（`maskCertificateNo`）。
   */
  certificateNo: string | null;
  /** 判定事實。業別層是查詢時指定的那一種業別（執業主體得兼營多種業別）。 */
  credential: CredentialFacts;
}

/** 查執業人員候選的條件，來自規則表席位的資格要求。 */
export interface PractitionerQuery {
  certificateKinds: readonly CertificateKind[];
  fullTime: boolean;
  /** 判定事實的業別層用哪一種業別。 */
  licenseKind: LicenseKind;
}

export interface PracticeRegistry {
  readonly kind: 'seed' | 'live';
  /** 依業別查執業主體。不給業別時全部列出。 */
  listEntities(query?: { licenseKind?: LicenseKind }): Promise<PracticeEntity[]>;
  getEntity(entityId: string): Promise<PracticeEntity | null>;
  listPartySigners(entityId: string): Promise<PartySignerCandidate[]>;
  getPartySigner(partySignerId: string): Promise<PartySignerCandidate | null>;
  /**
   * 依證書種類與專任要求查執業人員候選。
   * 不符資格的人（專任旗標為否、沒有證書、經紀營業員）不在清單內。
   */
  listPractitioners(entityId: string, query: PractitionerQuery): Promise<PractitionerCandidate[]>;
  /** 查單一執業人員，不套用資格條件。送簽前檢查用它取回已指派的人，才能列出被拒的原因。 */
  getPractitioner(practitionerId: string, query: Pick<PractitionerQuery, 'licenseKind'>): Promise<PractitionerCandidate | null>;
}

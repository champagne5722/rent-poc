import type { ContractFileKind, SignatureField, SignerRole } from '../types';

// 簽署模組與簽署服務商之間的 seam（ADR-0010）。adapter 只翻譯服務商 API，不含領域邏輯。

// 簽署標的的種類（ADR-0010 決議 2、ADR-0051 決議 1）。每種對到一個訂閱者，模組不依種類分支。
// 後三種是 E 線的文件，識別字與簽章分流規則表的文件類型相同（signature-routing 的 DOCUMENT_TYPES）。
// 新增一種標的：加進這裡、提供訂閱者、在 index.ts 註冊。
export const SIGNING_SUBJECT_TYPES = [
  'contract',
  'handover_certificate',
  'deposit_settlement',
  'deposit_refund_certificate',
] as const;
export type SigningSubjectType = (typeof SIGNING_SUBJECT_TYPES)[number];

// 簽署標的：送簽文件所屬的業務實體。
export interface SigningSubject {
  type: SigningSubjectType;
  // 業務實體的 ULID。簽署任務表的 subject_id 是文字，有 ULID 格式的 CHECK
  id: string;
}

export type SigningEventType = 'signed' | 'completed' | 'declined' | 'voided';

// 簽署事件：服務商回報、轉成平台標準形式的事件
export interface SigningEvent {
  type: SigningEventType;
  email?: string;
  reason?: string;
  // 事件時間，ISO 8601。服務商沒有提供時不帶。
  occurredAt?: string;
}

// 文件只傳資料。座標轉換與檔名清洗在 adapter。
export interface SignableDocument {
  fileName: string;
  pdf: Uint8Array;
  pageSize: { width: number; height: number };
}

// 簽署人驗證方式。第一版只有 email（ADR-0018 決議 13）。
// sms 與 twca_mid 需要電話或身分證字號，兩者都不得寫入 signers 表，評估時再設計傳遞方式。
export type SignerVerifyMethod = 'email';

// 簽署序列的一位簽署人。陣列順序就是簽署順序。
export interface Signer {
  // 主要角色
  role: SignerRole;
  name: string;
  email: string;
  // 同一人兼任時的其他角色（ADR-0018 決議 9）。記在 signers 表，查簽署進度時回傳。
  // 兼任角色的簽署區域放在 signatureFields，該區域的 signer 欄位是對應的角色。
  concurrentRoles?: SignerRole[];
  // 這位簽署人要用的驗證方式，合約層依規則表填入。不填時由 adapter 的部署設定決定。
  // 只在 adapter 設定為送驗證時才會送出，不會存進 signers 表。
  verifyMethods?: SignerVerifyMethod[];
  signatureFields: SignatureField[];
}

// 當前簽署人：簽署模組回給呼叫端的簽署人資訊
export type CurrentSigner = Pick<Signer, 'role' | 'name' | 'email'>;

// 解析 webhook 的四種結果
export type ParsedWebhook =
  | { kind: 'ping' }
  | { kind: 'ignored' }
  | { kind: 'invalid'; status: 400 | 401; reason: string }
  | { kind: 'event'; taskRef: string; event: SigningEvent };

export type WebhookHeaders = Pick<Headers, 'get'>;

// 簽署服務商的識別字，記在簽署任務上
export type SigningProviderId = 'dottedsign' | 'mock';

export interface SigningProvider {
  readonly id: SigningProviderId;
  readonly mode: 'mock' | 'live';
  // 服務商不支援的操作與對外訊息。簽署模組會先看這裡，再做其他檢查。
  readonly unsupported: {
    signLink?: string;
    resend?: string;
    simulate?: string;
    // 服務商沒有的檔案種類。簽署模組不保存這些種類，下載時回這裡的訊息。
    files?: Partial<Record<ContractFileKind, string>>;
  };
  createTask(input: {
    subject: SigningSubject;
    document: SignableDocument;
    signers: Signer[];
  }): Promise<{ taskRef: string }>;
  getSignLink(taskRef: string, email: string, redirectUrl?: string): Promise<string>;
  resend(taskRef: string): Promise<void>;
  voidTask(taskRef: string): Promise<void>;
  // 下載任務的文件本體。失敗時拋出的訊息會記進保存失敗紀錄。
  downloadFile(taskRef: string, kind: ContractFileKind): Promise<Uint8Array>;
  parseWebhook(rawBody: string, headers: WebhookHeaders): ParsedWebhook;
}

import type { ContractFileKind, SignatureField, SignerRole } from '../types';

// 簽署模組與簽署服務商之間的 seam（ADR-0010）。adapter 只翻譯服務商 API，不含領域邏輯。

// 簽署標的：送簽文件所屬的業務實體。目前只有合約。
export interface SigningSubject {
  type: 'contract';
  id: number;
}

export type SigningEventType = 'signed' | 'completed' | 'declined' | 'voided';

// 簽署事件：服務商回報、轉成平台標準形式的事件
export interface SigningEvent {
  type: SigningEventType;
  email?: string;
  reason?: string;
}

// 文件只傳資料。座標轉換與檔名清洗在 adapter。
export interface SignableDocument {
  fileName: string;
  pdf: Uint8Array;
  pageSize: { width: number; height: number };
}

// 簽署序列的一位簽署人。陣列順序就是簽署順序。
export interface Signer {
  role: SignerRole;
  name: string;
  email: string;
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
    // 服務商沒有的文件種類。簽署模組不保存這些種類，下載時回這裡的訊息。
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

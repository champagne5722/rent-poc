import type { ProgressOutcome } from './progress';
import type { Signer, SigningSubject } from './provider';

// 模組拒絕操作。status 與 message 就是對外的回應碼與訊息。
export class SigningRefusal extends Error {
  override readonly name = 'SigningRefusal';
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

// 簽署標的的訂閱者：簽署模組透過它通知業務實體，所以模組不依賴合約（ADR-0010 決議 7）。
// 新增一種簽署標的時，只提供一個訂閱者。
export interface SigningSubscriber {
  // 出現在對外訊息的名稱，例如「合約」
  readonly label: string;
  exists(subject: SigningSubject): Promise<boolean>;
  // 業務實體目前的狀態。模擬簽署事件時回給呼叫端。
  currentStatus(subject: SigningSubject): Promise<string>;
  // 業務實體是否已完成簽署。文件只在完成後存在，保存與下載前由這裡判定。
  isCompleted(subject: SigningSubject): Promise<boolean>;

  // 下面兩個各自在業務實體自己的交易內套用，提交後才回傳，不得呼叫外部 API。
  // 拋例外時業務實體沒有改變，簽署模組不會寫簽署進度，所以 webhook 重送可以重來（ADR-0010 決議 8）。
  // 簽署任務搬進 PostgreSQL 後（MIL-85）會改成與簽署進度同一個交易。
  // 不帶服務商任務編號：訂閱者看不到它（ADR-0010）。
  onSent(subject: SigningSubject, sent: { signers: Signer[] }): Promise<void>;
  onOutcome(subject: SigningSubject, outcome: ProgressOutcome): Promise<void>;

  // 交易提交後、模組保存文件之後呼叫，失敗不回滾狀態
  afterCompleted(subject: SigningSubject): Promise<void>;
  // 簽署標的沒有簽署任務時的撤回。不接受時拋 SigningRefusal。
  voidWithoutTask(subject: SigningSubject): Promise<void>;
}

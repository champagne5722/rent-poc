import type { OrgTx } from '../pg/with-tx';
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
//
// 帶 tx 的方法在簽署模組開的組織交易內被呼叫，與簽署進度同一個交易（ADR-0010 決議 8，MIL-85）：
// 任一步丟例外，整個交易回滾，簽署進度與業務實體都不變，所以 webhook 重送可以重來。
// 這些方法不得呼叫外部 API，也不得自己開交易（withTx 不得巢狀）。
// 業務實體要用 tx 讀寫時，查詢靠 RLS 篩選，別的組織的簽署標的和不存在的沒有差別。
export interface SigningSubscriber {
  // 出現在對外訊息的名稱，例如「合約」
  readonly label: string;
  exists(tx: OrgTx, subject: SigningSubject): Promise<boolean>;
  // 業務實體目前的狀態。模擬簽署事件時回給呼叫端。
  currentStatus(tx: OrgTx, subject: SigningSubject): Promise<string>;
  // 業務實體是否已完成簽署。文件只在完成後存在，保存與下載前由這裡判定。
  isCompleted(tx: OrgTx, subject: SigningSubject): Promise<boolean>;

  // 送簽前的檢查，在呼叫服務商之前執行：業務實體現在不能送簽時拋 SigningRefusal，
  // 才不會在服務商多建一個用不到的任務。沒有這個檢查的訂閱者得不實作。
  beforeSend?(tx: OrgTx, subject: SigningSubject): Promise<void>;
  // 不帶服務商任務編號：訂閱者看不到它（ADR-0010）。
  onSent(tx: OrgTx, subject: SigningSubject, sent: { signers: Signer[] }): Promise<void>;
  onOutcome(tx: OrgTx, subject: SigningSubject, outcome: ProgressOutcome): Promise<void>;
  // 簽署標的沒有簽署任務時的撤回。不接受時拋 SigningRefusal。
  voidWithoutTask(tx: OrgTx, subject: SigningSubject): Promise<void>;

  // 交易提交後、模組保存文件之後呼叫，失敗不回滾狀態。需要寫資料庫時自己開交易。
  afterCompleted(subject: SigningSubject): Promise<void>;
}

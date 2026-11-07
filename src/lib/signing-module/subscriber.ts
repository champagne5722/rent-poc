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
  exists(subject: SigningSubject): boolean;
  // 業務實體目前的狀態。模擬簽署事件時回給呼叫端。
  currentStatus(subject: SigningSubject): string;
  // 業務實體是否已完成簽署。文件只在完成後存在，保存與下載前由這裡判定。
  isCompleted(subject: SigningSubject): boolean;

  // 下面兩個在交易內被呼叫，不得呼叫外部 API。拋例外時簽署進度一起回滾（ADR-0010 決議 8）。
  // taskRef 只給合約雙寫舊欄位用，由收尾那張票（MIL-60）移除。
  onSent(subject: SigningSubject, sent: { taskRef: string; signers: Signer[] }): void;
  onOutcome(subject: SigningSubject, outcome: ProgressOutcome): void;

  // 交易提交後、模組保存文件之後呼叫，失敗不回滾狀態
  afterCompleted(subject: SigningSubject): Promise<void>;
  // 簽署標的沒有簽署任務時的撤回。不接受時拋 SigningRefusal。
  voidWithoutTask(subject: SigningSubject): void;
}

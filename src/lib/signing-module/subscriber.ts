import type { ProgressOutcome } from './progress';
import type { Signer, SigningEvent, SigningSubject } from './provider';

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

// 送簽時，呼叫端交給訂閱者的業務資料。簽署模組不讀、不改，原樣傳給 onSent。
// 型別由訂閱者自己定義並檢查（例如合約的 ContractSendContext）。
export type SendContext = unknown;

// 簽署事件進交易時，模組交給 onOutcome 的資料
export interface OutcomeContext {
  // 事件時間，ISO 8601。服務商沒有提供時用模組的現在時間。簽署當下的判定用它（ADR-0018 決議 11）。
  eventAt: string;
  // prepareOutcome 的回傳值，沒有實作 prepareOutcome 時是 undefined
  prepared?: unknown;
}

// 模組交給 afterOutcome 的操作
export interface AfterOutcomeTools {
  voidTask(): Promise<void>;
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
  // 不帶服務商任務編號：訂閱者看不到它（ADR-0010）。
  // context 是 signing.send 第四個參數，原樣傳入
  onSent(subject: SigningSubject, sent: { signers: Signer[]; context?: SendContext }): void;
  onOutcome(subject: SigningSubject, outcome: ProgressOutcome, context: OutcomeContext): void;

  // 選填。簽署事件進交易之前呼叫，可以呼叫外部來源（例如登錄資料）。
  // 回傳值放進 onOutcome 的 context.prepared。拋例外時模組記 log 並當作沒有準備，不影響簽署進度。
  prepareOutcome?(subject: SigningSubject, event: SigningEvent, eventAt: string): Promise<unknown>;

  // 交易提交後、模組保存文件之後呼叫，失敗不回滾狀態
  afterCompleted(subject: SigningSubject): Promise<void>;
  // 選填。每個被接受的簽署事件在交易提交後呼叫（全員完成時在 afterCompleted 之後），能呼叫外部 API。
  // 拋例外時模組記 log，不影響 webhook 的回應碼，也不回滾已提交的狀態。
  // tools.voidTask 撤回這個簽署標的的簽署任務，與使用者手動撤回走同一條路徑。
  // 例如簽署當下不可簽章時自動撤回（MIL-75，ADR-0018 決議 11）。
  afterOutcome?(subject: SigningSubject, outcome: ProgressOutcome, tools: AfterOutcomeTools): Promise<void>;
  // 簽署標的沒有簽署任務時的撤回。不接受時拋 SigningRefusal。
  voidWithoutTask(subject: SigningSubject): void;
}

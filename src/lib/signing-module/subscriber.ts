import type { OrgTx } from '../pg/with-tx';
import type { ProgressOutcome } from './progress';
import type { Signer, SigningEvent, SigningSubject, SigningSubjectType } from './provider';

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

// prepareOutcome 在交易外執行，沒有 tx。模組給一個函式，讓它開短的唯讀組織交易查本機資料。
export type ReadInOrg = <T>(fn: (tx: OrgTx) => Promise<T>) => Promise<T>;

// 簽署事件進交易時，模組交給 onOutcome 的資料
export interface OutcomeContext {
  // 事件時間，ISO 8601。服務商沒有提供時用模組的現在時間。簽署當下的判定用它（ADR-0018 決議 11）。
  eventAt: string;
  // prepareOutcome 的回傳值，沒有實作 prepareOutcome 時是 undefined
  prepared?: unknown;
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
  // sent.context 是 signing.send 選項的 context，原樣傳入（MIL-70）
  onSent(tx: OrgTx, subject: SigningSubject, sent: { signers: Signer[]; context?: SendContext }): Promise<void>;
  // outcomeContext 的 eventAt 是事件時間，prepared 是 prepareOutcome 的回傳值（MIL-70）
  onOutcome(
    tx: OrgTx,
    subject: SigningSubject,
    outcome: ProgressOutcome,
    outcomeContext: OutcomeContext
  ): Promise<void>;

  // 選填。簽署事件進交易之前呼叫，沒有 tx，可以呼叫外部來源（例如登錄資料）。
  // 回傳值放進 onOutcome 的 outcomeContext.prepared。拋例外時模組記 log 並當作沒有準備，不影響簽署進度。
  // read 開一個唯讀的組織交易，讀完就提交，供準備時查本機資料。外部來源的查詢放在 read 之外。
  prepareOutcome?(
    subject: SigningSubject,
    event: SigningEvent,
    eventAt: string,
    read: ReadInOrg
  ): Promise<unknown>;

  // 簽署標的沒有簽署任務時的撤回。不接受時拋 SigningRefusal。
  voidWithoutTask(tx: OrgTx, subject: SigningSubject): Promise<void>;

  // 交易提交後、模組保存文件之後呼叫，失敗不回滾狀態。需要寫資料庫時自己開交易。
  afterCompleted(subject: SigningSubject): Promise<void>;
}

// 簽署模組的訂閱者註冊：依 subject.type 分派。還沒有訂閱者的種類不註冊，模組對它回 404。
export type SigningSubscribers = Partial<Record<SigningSubjectType, SigningSubscriber>>;

import { createHash } from 'node:crypto';
import { buildObjectKey, parseObjectKey, sha256Hex, type FileStore } from '../file-store';
import { jsonError } from '../http';
import type { OrgContext, OrgTx } from '../pg/with-tx';
import { OrgContextRequired, Unauthenticated } from '../request-context';
import { CONTRACT_FILE_KINDS, CONTRACT_FILE_LABELS } from '../types';
import type { ContractFileKind } from '../types';
import { defaultSigningDb, type SigningDb } from './db';
import {
  claimInbox,
  failInbox,
  finishInbox,
  insertInbox,
  listPendingInbox,
  recoverStaleInbox,
  type InboxStatus,
} from './inbox';
import {
  claimOutbox,
  completeOutbox,
  enqueueOutbox,
  failOutbox,
  findOpenOutbox,
  listDueOutbox,
  recoverStaleOutbox,
  type OutboxRow,
  type OutboxStatus,
} from './outbox';
import { advanceProgress, normalizeEmail, type ProgressOutcome } from './progress';
import type {
  CurrentSigner,
  SignableDocument,
  Signer,
  SigningEvent,
  SigningEventType,
  SigningProvider,
  SigningSubject,
  WebhookHeaders,
} from './provider';
import { getSignTaskFile, listSignTaskFiles, upsertSignTaskFile, type SignTaskFile } from './sign-task-files';
import {
  currentSignerOf,
  findSignTask,
  findSignTaskByRef,
  findSignTaskRoute,
  findSignTasks,
  insertSignTask,
  saveProgress,
  toSigningProgress,
  type SignTaskRecord,
  type SigningProgress,
} from './sign-task-store';
import {
  SigningRefusal,
  type AfterOutcomeTools,
  type OutcomeContext,
  type ReadInOrg,
  type SendContext,
  type SigningSubscriber,
} from './subscriber';

// 簽署模組（ADR-0010）：route handler 只呼叫這裡，服務商細節都在 adapter，
// 業務實體的細節都在訂閱者。介面一律回傳 Promise，呼叫端看不到服務商任務編號。
//
// 資料在 PostgreSQL（MIL-85）。每個操作拆成「交易、外部呼叫、交易」，交易內沒有外部 API 呼叫（ADR-0012 決議 10）：
// - 簽署進度、業務實體狀態與歷程在同一個交易寫入，任一步失敗整筆回滾（ADR-0010 決議 8）。
// - 對外呼叫（建立、撤回、重寄）先在交易內寫 outbox 列，提交後在同一請求內派送一次（ADR-0020 決議 5）。
//   建立簽署任務失敗不自動重試，撤回與重寄失敗留待排程重試（drain-outbox 屬 MIL-86）。

export { SigningRefusal } from './subscriber';

// 平台的簽署任務
export interface SignTask {
  subject: SigningSubject;
  mode: SigningProvider['mode'];
}

// webhook 的回應碼與回應內容
export interface WebhookAck {
  status: number;
  body: { ok: true; ping?: true; ignored?: true; queued?: true } | { error: string };
}

// mock advance 可模擬的簽署事件。撤回有自己的操作。
const SIMULATABLE_EVENTS: readonly SigningEventType[] = ['signed', 'completed', 'declined'];

export interface SigningModuleDeps {
  provider: SigningProvider;
  // 以 subject.type 為鍵
  subscribers: Record<string, SigningSubscriber>;
  // 文件本體的儲存（signed-document 用途）。文件紀錄只記物件 key 與 SHA-256（MIL-87）。
  files: FileStore;
  // 模擬簽署事件（mock advance）的事件時間來源。真實 webhook 的事件時間由服務商提供。
  now?: () => Date;
  // 取得資料庫交易的方式。預設用目前請求的組織脈絡與 withTx，測試可以換成固定組織。
  db?: SigningDb;
}

// 保存一種文件的結果
export interface SaveFileResult {
  kind: ContractFileKind;
  ok: boolean;
  error?: string;
}

// 保存文件的範圍。沒給 kinds 時保存服務商有的全部種類。沒帶 force 時已保存的不重抓。
export interface SaveFilesOptions {
  kinds?: readonly ContractFileKind[];
  force?: boolean;
}

// 送簽的選項
export interface SendOptions {
  // 業務資料，原樣交給訂閱者的 onSent，在送簽交易內使用（MIL-70）。例如簽章紀錄的送簽資料。
  // 模組不讀、不改。丟例外時整個送簽回滾。
  context?: SendContext;
  // 與建立簽署任務同一個交易執行（簽署進度、合約狀態與歷程已寫入後）。
  // 丟例外時整個送簽回滾。交易內不得有外部 API 呼叫。
  alsoInTx?: (tx: OrgTx) => Promise<void>;
}

// 簽署事件的交易前準備結果（prepareEvent）：事件時間與訂閱者 prepareOutcome 的回傳值
interface PreparedEvent {
  eventAt: string;
  prepared?: unknown;
}

// 下載端點回給使用者的文件
export interface DownloadedFile {
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

// 處理一列 inbox 的結果。webhook 請求內的第一次處理與排程（drain-inbox）共用。
export type InboxResult =
  | { kind: 'done' }
  | { kind: 'ignored'; reason: string }
  | { kind: 'deferred'; reason: string; status: InboxStatus }
  | { kind: 'failed'; error: string; status: InboxStatus }
  | { kind: 'not_claimed' };

// 派送一列 outbox 的結果。排程（MIL-86）與請求內派送共用。
export type DispatchResult =
  | { kind: 'done' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; error: string; status: OutboxStatus }
  | { kind: 'not_claimed' };

// 物件 key：org/<org_id>/sign-tasks/<簽署任務 id>/<檔名>。org_id 在最前面，不同組織的檔案不會撞名。
const FILES_AREA = 'sign-tasks';
const FILE_SUFFIX: Record<ContractFileKind, string> = { signed_pdf: 'signed', audit_trail: 'audit-trail' };

export function createSigningModule({
  provider,
  subscribers,
  files,
  now = () => new Date(),
  db = defaultSigningDb,
}: SigningModuleDeps) {
  async function requireSubscriber(tx: OrgTx, subject: SigningSubject): Promise<SigningSubscriber> {
    const subscriber = subscribers[subject.type];
    if (!subscriber) throw new SigningRefusal(404, '不支援的簽署標的');
    if (!(await subscriber.exists(tx, subject))) throw new SigningRefusal(404, `${subscriber.label}不存在`);
    return subscriber;
  }

  // 簽署事件進交易之前的準備（MIL-70）：定出事件時間，並讓訂閱者查外部來源（例如登錄資料）。
  // 必須在交易外呼叫，交易內不得有外部呼叫。準備失敗不擋下簽署進度，見 prepareOutcome。
  async function prepareEvent(
    ctx: OrgContext,
    subject: SigningSubject,
    subscriber: SigningSubscriber,
    event: SigningEvent
  ): Promise<PreparedEvent> {
    const eventAt = event.occurredAt ?? now().toISOString();
    const read: ReadInOrg = (fn) => db.inOrg(ctx, fn);
    return { eventAt, prepared: await prepareOutcome(subject, subscriber, event, eventAt, read) };
  }

  // webhook、撤回與 mock advance 共用這條路徑，確保模擬與真接行為一致。
  // 在呼叫端的交易內：鎖住簽署任務列、讀進度、推進、套用業務實體狀態與歷程、寫進度。任一步失敗整筆回滾。
  // 鎖讓同一個任務的兩個事件（webhook 重送）依序處理，後到的看得到先到的結果，不會雙重套用。
  // 不接受的事件回 null 並記 log，什麼都沒寫。
  // 保存文件與訂閱者的完成後處理是外部 IO，由呼叫端在提交後做（finishAfterCommit）。
  async function applyEventTx(
    tx: OrgTx,
    subject: SigningSubject,
    subscriber: SigningSubscriber,
    event: SigningEvent | ((task: SignTaskRecord) => SigningEvent),
    prep?: PreparedEvent
  ): Promise<ProgressOutcome | null> {
    const task = await findSignTask(tx, subject, { lock: true });
    if (!task) return logIgnored(subject, typeOfEvent(event), 'no_task');
    const resolved = typeof event === 'function' ? event(task) : event;
    const advance = advanceProgress(task, resolved);
    if (!advance.accepted) return logIgnored(subject, resolved.type, advance.reason);
    // 事件時間：服務商提供的優先，沒有時用現在時間。訂閱者的判定用它，不用系統收到事件的時間（MIL-70）。
    // prep 是交易前 prepareEvent 的結果，沒有時 eventAt 取現在，prepared 為空。
    const outcomeContext: OutcomeContext = {
      eventAt: prep?.eventAt ?? resolved.occurredAt ?? now().toISOString(),
      prepared: prep?.prepared,
    };
    await subscriber.onOutcome(tx, subject, advance.outcome, outcomeContext);
    await saveProgress(tx, task, advance);
    // 全員完成：保存文件的 outbox 列與完成狀態同交易寫入。提交後才派送，進程在這之間中斷也不會漏掉（MIL-87）
    if (advance.outcome.type === 'completed') await enqueueOutbox(tx, { action: 'save_sign_task_files', subject });
    return advance.outcome;
  }

  // 提交後的處理，保存文件與訂閱者的後處理都是外部 IO，失敗不回滾狀態：
  // - 全員完成：保存文件，再呼叫 afterCompleted。
  // - 每個被接受的事件：呼叫選填的 afterOutcome（全員完成時在 afterCompleted 之後），例如自動撤回（MIL-75）。
  async function finishAfterCommit(
    ctx: OrgContext,
    subject: SigningSubject,
    subscriber: SigningSubscriber,
    outcome: ProgressOutcome | null
  ): Promise<void> {
    if (!outcome) return;
    if (outcome.type === 'completed') {
      await saveFilesOnCompleted(ctx, subject, subscriber);
      await runAfterCompleted(subject, subscriber);
    }
    await runAfterOutcome(subject, subscriber, outcome, {
      voidTask: () => voidTaskIn(ctx, subject),
      inOrg: (fn) => db.inOrg(ctx, fn),
    });
  }

  // 撤回。呼叫服務商期間可能收到全員完成事件。applyEventTx 會在交易內重讀進度，
  // 所以這時撤回不接受並回 409，已完成的簽署標的不會被改成已撤回。
  // 使用者手動撤回與 afterOutcome 的 tools.voidTask 走同一條路徑。組織脈絡由呼叫端給：
  // 手動撤回是請求的脈絡，webhook 與排程裡的自動撤回是該事件所屬的組織。
  async function voidTaskIn(ctx: OrgContext, subject: SigningSubject): Promise<void> {
    const plan = await db.inOrg(ctx, async (tx) => {
      const subscriber = await requireSubscriber(tx, subject);
      const task = await findSignTask(tx, subject);
      if (!task) {
        // 沒有服務商任務，沒有外部呼叫，在同一個交易直接撤回
        await subscriber.voidWithoutTask(tx, subject);
        return null;
      }
      if (task.status !== 'in_progress') throw new SigningRefusal(409, `僅簽署中的${subscriber.label}可撤回`);
      await recoverStaleOutbox(tx, subject);
      const entry = await enqueueOutbox(tx, { action: 'void_sign_task', subject });
      return { subscriber, outboxId: entry.row.id };
    });
    if (!plan) return;

    const result = await dispatchOutbox(ctx, plan.outboxId);
    if (result.kind === 'not_claimed') throw new SigningRefusal(409, '撤回處理中，請稍後再試');
    if (result.kind === 'failed') throw dispatchFailure(plan.subscriber, '撤回', result);
    if (result.kind === 'skipped') throw new SigningRefusal(409, `僅簽署中的${plan.subscriber.label}可撤回`);
  }

  // 派送完成時寫入的那一列 outbox（applyEventTx）。第一次派送在這裡，同一請求內做；
  // 失敗的列留在 pending，由排程重試（MIL-86 的 drain-outbox），用完重試轉 dead 進人工處理清單。
  // 刻意不讓例外往外拋：webhook 回非 2xx 會被點點簽重試，
  // 單日累積 10 次投遞失敗會停掉整個 application 的 webhook。失敗的種類之後可補抓。
  async function saveFilesOnCompleted(
    ctx: OrgContext,
    subject: SigningSubject,
    subscriber: SigningSubscriber
  ): Promise<void> {
    try {
      const open = await db.inOrg(ctx, (tx) => findOpenOutbox(tx, subject, 'save_sign_task_files'));
      if (open) await dispatchOutbox(ctx, open.id);
    } catch (e) {
      console.error(`[signing] ${describeSubject(subject, subscriber)}完成時保存文件失敗：${errorMessage(e)}`);
    }
  }

  // 服務商沒有的種類不保存。沒帶 force 時，已保存的種類不重抓。
  // 下載與寫檔在交易外，文件紀錄各自一個小交易。
  async function saveTaskFiles(
    ctx: OrgContext,
    subject: SigningSubject,
    subscriber: SigningSubscriber,
    options: SaveFilesOptions
  ): Promise<SaveFileResult[]> {
    const kinds = (options.kinds ?? CONTRACT_FILE_KINDS).filter((kind) => !provider.unsupported.files?.[kind]);
    const task = await db.inOrg(ctx, (tx) => findSignTask(tx, subject));
    if (!task) {
      return kinds.map((kind) => logFailure(subject, subscriber, kind, `${subscriber.label}沒有對應的簽署任務`));
    }

    const results: SaveFileResult[] = [];
    for (const kind of kinds) {
      if (!options.force) {
        const existing = await db.inOrg(ctx, (tx) => getSignTaskFile(tx, task.id, kind));
        if (existing?.status === 'saved') continue;
      }
      const fileName = fileNameOf(subject, kind);
      try {
        const bytes = await provider.downloadFile(task.taskRef, kind);
        const key = buildObjectKey(ctx.orgId, FILES_AREA, task.id, fileName);
        const written = await files.write(key, bytes, { contentType: PDF });
        await db.inOrg(ctx, (tx) =>
          upsertSignTaskFile(tx, task.id, {
            kind,
            status: 'saved',
            file_name: fileName,
            object_key: key,
            sha256: written.sha256,
            byte_size: written.byteSize,
            content_type: PDF,
            error: null,
          })
        );
        results.push({ kind, ok: true });
      } catch (e) {
        const error = errorMessage(e);
        await db.inOrg(ctx, (tx) =>
          upsertSignTaskFile(tx, task.id, {
            kind,
            status: 'failed',
            file_name: fileName,
            object_key: null,
            sha256: null,
            byte_size: null,
            content_type: null,
            error,
          })
        );
        results.push(logFailure(subject, subscriber, kind, error));
      }
    }
    return results;
  }

  // 檔案不在 FileStore（被刪掉、舊版本機路徑）或內容的 SHA-256 與紀錄不符時，視為未保存，交給呼叫端補抓。
  // 讀取本身失敗（權限、網路）往外丟，下載回 502，不當成不存在而覆蓋紀錄。
  async function readSavedFile(file: SignTaskFile | null): Promise<DownloadedFile | null> {
    if (!file || file.status !== 'saved' || !file.object_key) return null;
    const bytes = await files.read(parseObjectKey(file.object_key));
    if (!bytes) return null;
    if (file.sha256 && sha256Hex(bytes) !== file.sha256) {
      console.error(`[signing] ${file.object_key} 的內容與紀錄的 SHA-256 不符，視為未保存並重新取得`);
      return null;
    }
    return { fileName: file.file_name, contentType: file.content_type ?? PDF, bytes };
  }

  // 派送一列撤回或重寄的 outbox。請求內的第一次派送與排程的重試共用。
  // 認領（pending 轉 sending）在第一個交易，服務商呼叫在交易外，結果在第二個交易寫回：
  // 撤回成功時，進度、合約狀態、歷程與 outbox 完成標記同一個交易。
  async function dispatchOutbox(ctx: OrgContext, outboxId: string): Promise<DispatchResult> {
    const claimed = await db.inOrg(ctx, async (tx) => {
      const row = await claimOutbox(tx, outboxId);
      if (!row) return null;
      if (row.action === 'create_sign_task') {
        // 建立簽署任務的文件只在記憶體，無從重送。不該排進來，保險起見直接轉失敗
        await failOutbox(tx, row, '建立簽署任務不重試');
        return null;
      }
      return { row, task: await findSignTask(tx, row.subject) };
    });
    if (!claimed) return { kind: 'not_claimed' };
    const { row, task } = claimed;
    const subscriber = subscribers[row.subject.type];

    if (row.action === 'save_sign_task_files') return dispatchSaveFiles(ctx, row, subscriber, task !== null);

    if (!subscriber || !task || task.status !== 'in_progress') {
      const reason = '簽署任務已不在簽署中';
      await db.inOrg(ctx, (tx) => completeOutbox(tx, row.id, { status: 'skipped', note: reason }));
      return { kind: 'skipped', reason };
    }

    try {
      if (row.action === 'void_sign_task') await provider.voidTask(task.taskRef);
      else await provider.resend(task.taskRef);
    } catch (e) {
      const error = errorMessage(e);
      const status = await db.inOrg(ctx, (tx) => failOutbox(tx, row, error));
      return { kind: 'failed', error, status };
    }

    // 撤回事件的準備在交易外做（MIL-70）。重寄不套用事件
    const voidedEvent: SigningEvent = { type: 'voided' };
    const prep = row.action === 'void_sign_task' ? await prepareEvent(ctx, row.subject, subscriber, voidedEvent) : undefined;
    const voided: { outcome: ProgressOutcome | null } = { outcome: null };
    let result: DispatchResult;
    try {
      result = await db.inOrg(ctx, async (tx): Promise<DispatchResult> => {
        if (row.action === 'void_sign_task') {
          const outcome = await applyEventTx(tx, row.subject, subscriber, voidedEvent, prep);
          voided.outcome = outcome;
          if (!outcome) {
            // 服務商的 voided webhook 比這裡先到：進度已是撤回，目的達成
            if ((await findSignTask(tx, row.subject))?.status === 'voided') {
              await completeOutbox(tx, row.id, { status: 'done', note: '撤回事件已先到' });
              return { kind: 'done' };
            }
            // 呼叫服務商期間收到全員完成事件：applyEventTx 在交易內重讀進度，已完成的不會被改成已撤回
            const reason = '呼叫服務商期間簽署任務已結束';
            await completeOutbox(tx, row.id, { status: 'skipped', note: reason });
            return { kind: 'skipped', reason };
          }
        }
        await completeOutbox(tx, row.id, { status: 'done' });
        return { kind: 'done' };
      });
    } catch (e) {
      // 服務商已回應成功，平台沒記下來。列轉回等待重試，不留在 sending 卡住同一個簽署標的
      const error = errorMessage(e);
      console.error(`[signing] ${describeSubject(row.subject, subscriber)}的${row.action}已送出，但寫回平台失敗：${error}`);
      await db.inOrg(ctx, (tx) => failOutbox(tx, row, error)).catch(() => undefined);
      throw e;
    }
    // 撤回事件提交後的處理（例如結清失效紀錄）。例外只記 log，不影響撤回的結果
    await finishAfterCommit(ctx, row.subject, subscriber, voided.outcome);
    return result;
  }

  // 保存文件：向服務商下載、寫入 FileStore、記文件紀錄。已保存的種類略過，所以重試只補沒成功的。
  // 每種文件的失敗都已記進文件紀錄（saveTaskFiles），這裡只決定 outbox 列的去向：全部成功算完成，
  // 有失敗就記一次失敗（回 pending 等重試，用完轉 dead）。狀態不回滾，這一列與完成狀態無關。
  async function dispatchSaveFiles(
    ctx: OrgContext,
    row: OutboxRow,
    subscriber: SigningSubscriber | undefined,
    hasTask: boolean
  ): Promise<DispatchResult> {
    if (!subscriber || !hasTask) {
      const reason = '沒有對應的簽署任務';
      await db.inOrg(ctx, (tx) => completeOutbox(tx, row.id, { status: 'skipped', note: reason }));
      return { kind: 'skipped', reason };
    }
    let failures: string[];
    try {
      const results = await saveTaskFiles(ctx, row.subject, subscriber, {});
      failures = results.filter((r) => !r.ok).map((r) => `${CONTRACT_FILE_LABELS[r.kind]}：${r.error ?? '未知原因'}`);
    } catch (e) {
      failures = [errorMessage(e)];
    }
    if (failures.length === 0) {
      await db.inOrg(ctx, (tx) => completeOutbox(tx, row.id, { status: 'done' }));
      return { kind: 'done' };
    }
    const error = failures.join('；');
    const status = await db.inOrg(ctx, (tx) => failOutbox(tx, row, error));
    return { kind: 'failed', error, status };
  }

  // 派送失敗回給使用者的訊息：寫明已排入重試，或重試用完需人工處理
  function dispatchFailure(subscriber: SigningSubscriber, action: string, result: Extract<DispatchResult, { kind: 'failed' }>) {
    const tail = result.status === 'dead' ? '。重試次數已用完，需要人工處理' : '。已排入重試';
    return new SigningRefusal(502, `${action}${subscriber.label}失敗：${result.error}${tail}`);
  }

  return {
    mode: async () => provider.mode,

    // 流程：交易一檢查並寫 outbox 列（sending），外部建立服務商任務，交易二寫簽署任務、簽署人、路由列、
    // 合約狀態與歷程並把 outbox 標完成。服務商建立失敗時合約維持草稿，outbox 轉 failed，不自動重試。
    // 同一個簽署標的的兩個送簽：第二個撞 outbox 的唯一索引，直接 409，不會在服務商多建任務。
    async send(
      subject: SigningSubject,
      document: SignableDocument,
      signers: Signer[],
      options: SendOptions = {}
    ): Promise<SignTask> {
      const ctx = await db.requestOrg();
      const { outboxId, subscriber } = await db.inOrg(ctx, async (tx) => {
        const subscriber = await requireSubscriber(tx, subject);
        refuseInvalidSequence(signers);
        // 先擋下來，才不會在服務商多建一個用不到的任務
        if (await findSignTask(tx, subject)) throw new SigningRefusal(409, '這個簽署標的已有簽署任務');
        await subscriber.beforeSend?.(tx, subject);
        await recoverStaleOutbox(tx, subject);
        const { row, created } = await enqueueOutbox(tx, { action: 'create_sign_task', subject, sending: true });
        if (!created) throw new SigningRefusal(409, '送簽處理中，請稍後再試');
        return { outboxId: row.id, subscriber };
      });
      const outbox = { id: outboxId, action: 'create_sign_task', attempts: 1 } as const;

      let taskRef: string;
      try {
        ({ taskRef } = await provider.createTask({ subject, document, signers }));
      } catch (e) {
        await markCreateFailed(ctx, outbox, errorMessage(e));
        throw e;
      }

      try {
        await db.inOrg(ctx, async (tx) => {
          const inserted = await insertSignTask(tx, { provider: provider.id, taskRef, subject, signers });
          // 簽署標的或服務商任務編號已有簽署任務：丟例外讓交易回滾，合約維持草稿
          if (!inserted) throw new SigningRefusal(409, '簽署標的或服務商任務編號已有簽署任務');
          await subscriber.onSent(tx, subject, { signers, context: options.context });
          await options.alsoInTx?.(tx);
          await completeOutbox(tx, outbox.id, { status: 'done', providerTaskRef: taskRef });
        });
      } catch (e) {
        // 服務商已建立任務，平台沒有記下來。任務編號只留在 log 與 outbox 列，供人工清理孤兒任務
        console.error(`[signing] ${describeSubject(subject, subscriber)}送簽：服務商任務已建立（${taskRef}），但寫入平台失敗：${errorMessage(e)}`);
        await markCreateFailed(ctx, outbox, errorMessage(e), taskRef);
        throw e;
      }
      return { subject, mode: provider.mode };
    },

    async getProgress(subject: SigningSubject): Promise<SigningProgress | null> {
      const ctx = await db.requestOrg();
      const task = await db.inOrg(ctx, (tx) => findSignTask(tx, subject));
      return task ? toSigningProgress(task) : null;
    },

    // 批次取簽署進度，清單用（MIL-72）。回傳以 signingSubjectKey 為鍵的 Map，沒有簽署任務的簽署標的不在裡面。
    async getProgressBatch(subjects: readonly SigningSubject[]): Promise<Map<string, SigningProgress>> {
      const ctx = await db.requestOrg();
      const tasks = await db.inOrg(ctx, (tx) => findSignTasks(tx, subjects));
      return new Map([...tasks].map(([key, task]) => [key, toSigningProgress(task)]));
    },

    async getSignLink(subject: SigningSubject, redirectUrl?: string): Promise<{ signer: CurrentSigner; url: string }> {
      const ctx = await db.requestOrg();
      const { signer, taskRef } = await db.inOrg(ctx, async (tx) => {
        const subscriber = await requireSubscriber(tx, subject);
        refuseIfUnsupported(provider.unsupported.signLink, 409);
        return requireCurrentSigner(tx, subject, subscriber);
      });
      return { signer, url: await provider.getSignLink(taskRef, signer.email, redirectUrl) };
    },

    async resend(subject: SigningSubject): Promise<{ signer: CurrentSigner }> {
      const ctx = await db.requestOrg();
      const { signer, subscriber, entry } = await db.inOrg(ctx, async (tx) => {
        const subscriber = await requireSubscriber(tx, subject);
        refuseIfUnsupported(provider.unsupported.resend, 409);
        const { signer } = await requireCurrentSigner(tx, subject, subscriber);
        await recoverStaleOutbox(tx, subject);
        const entry = await enqueueOutbox(tx, { action: 'resend_sign_task', subject });
        return { signer, subscriber, entry };
      });
      // 已有一列在重試中（pending）時，這次請求直接派送它，不另排一列
      const result = await dispatchOutbox(ctx, entry.row.id);
      if (result.kind === 'not_claimed') throw new SigningRefusal(409, '重寄處理中，請稍後再試');
      if (result.kind === 'failed') throw dispatchFailure(subscriber, '重寄', result);
      if (result.kind === 'skipped') throw new SigningRefusal(409, `${subscriber.label}不在簽署中，沒有待簽方`);
      return { signer };
    },

    voidTask: async (subject: SigningSubject) => voidTaskIn(await db.requestOrg(), subject),

    // 排程（MIL-86 的 drain-outbox）與測試用：派送一列，或處理一個組織到期的列。
    // 這個模組不知道有哪些組織，組織清單由呼叫端從 control 取得（ADR-0020 決議 7）。
    dispatchOutbox: (orgId: string, outboxId: string) => dispatchOutbox({ kind: 'org', orgId }, outboxId),

    async drainOutbox(orgId: string, limit: number): Promise<DispatchResult[]> {
      const ctx: OrgContext = { kind: 'org', orgId };
      const due = await db.inOrg(ctx, async (tx) => {
        await recoverStaleOutbox(tx);
        return listDueOutbox(tx, limit);
      });
      const results: DispatchResult[] = [];
      for (const row of due) {
        // 一列失敗不影響其他列
        try {
          results.push(await dispatchOutbox(ctx, row.id));
        } catch (e) {
          console.error(`[signing] 派送 outbox ${row.id} 失敗：${errorMessage(e)}`);
        }
      }
      return results;
    },

    // webhook 驗簽後先把標準化的事件寫進 inbox，同一個請求內處理一次（ADR-0020 決議 5）。
    // 寫入成功就回 2xx：處理失敗或路由列還沒寫入的事件留在 inbox，由 drain-inbox 重試。
    // 寫不進 inbox 才回非 2xx（例外往外拋），讓服務商重送。
    // 非 2xx 在服務商端會重試，單日累積 10 次投遞失敗會停掉整個 application 的 webhook，所以寫入之後一律 2xx。
    async ingestWebhook(rawBody: string, headers: WebhookHeaders): Promise<WebhookAck> {
      const parsed = provider.parseWebhook(rawBody, headers);
      const ignored: WebhookAck = { status: 200, body: { ok: true, ignored: true } };
      switch (parsed.kind) {
        case 'ping':
          return { status: 200, body: { ok: true, ping: true } };
        case 'ignored':
          return ignored;
        case 'invalid':
          return { status: parsed.status, body: { error: parsed.reason } };
        case 'event': {
          // 只存雜湊，不存原始 body
          const bodySha256 = createHash('sha256').update(rawBody).digest('hex');
          const stored = await db.inControl((tx) =>
            insertInbox(tx, { provider: provider.id, bodySha256, taskRef: parsed.taskRef, event: parsed.event }),
          );
          // 服務商重送的 body 一字不差：已收過就不再處理
          if (!stored.created) return ignored;
          const result = await processInboxSafely(stored.id);
          if (result.kind === 'done') return { status: 200, body: { ok: true } };
          if (result.kind === 'ignored') return ignored;
          return { status: 200, body: { ok: true, queued: true } };
        }
      }
    },

    // 排程（drain-inbox）用：重試還沒處理完的列，一次最多 limit 列。一列失敗不影響其他列。
    // inbox 在 control，沒有組織脈絡，所以不用逐組織。每列的組織由路由列查出。
    async drainInbox(limit: number): Promise<InboxResult[]> {
      const due = await db.inControl(async (tx) => {
        await recoverStaleInbox(tx);
        return listPendingInbox(tx, provider.id, limit);
      });
      const results: InboxResult[] = [];
      for (const row of due) results.push(await processInboxSafely(row.id));
      return results;
    },

    // 不經 webhook 模擬簽署事件。event 與 reason 來自未驗證的請求 body，這裡才檢查。
    // 模擬的簽署人已簽一律是當前簽署人。模擬事件沒有服務商，事件時間取現在。
    async simulateEvent(subject: SigningSubject, event: unknown, reason?: unknown): Promise<{ status: string }> {
      refuseIfUnsupported(provider.unsupported.simulate, 403);
      const ctx = await db.requestOrg();
      // 交易一：檢查並定出模擬事件。事件的 email 是當前簽署人
      const simulated = await db.inOrg(ctx, async (tx) => {
        const subscriber = await requireSubscriber(tx, subject);
        if (!SIMULATABLE_EVENTS.includes(event as SigningEventType)) {
          throw new SigningRefusal(400, '不支援的事件');
        }
        const task = await findSignTask(tx, subject);
        const simulatedEvent: SigningEvent = {
          type: event as SigningEventType,
          email: task ? currentSignerOf(task)?.email : undefined,
          reason: typeof reason === 'string' ? reason : undefined,
          occurredAt: now().toISOString(),
        };
        return { subscriber, simulatedEvent };
      });
      // 事件進交易之前的準備（MIL-70），交易外
      const prep = await prepareEvent(ctx, subject, simulated.subscriber, simulated.simulatedEvent);
      const applied = await db.inOrg(ctx, async (tx) => {
        const outcome = await applyEventTx(tx, subject, simulated.subscriber, simulated.simulatedEvent, prep);
        const status = await simulated.subscriber.currentStatus(tx, subject);
        if (!outcome) throw new SigningRefusal(409, `目前狀態（${status}）不接受此事件`);
        return { subscriber: simulated.subscriber, outcome, status };
      });
      await finishAfterCommit(ctx, subject, applied.subscriber, applied.outcome);
      return { status: applied.status };
    },

    // 補抓文件。完成當下保存失敗（服務商暫時性錯誤、連結過期等）時的補救手段。
    async saveFiles(subject: SigningSubject, options: SaveFilesOptions = {}): Promise<SaveFileResult[]> {
      const ctx = await db.requestOrg();
      const subscriber = await db.inOrg(ctx, async (tx) => {
        const found = await requireSubscriber(tx, subject);
        if (!(await found.isCompleted(tx, subject))) {
          throw new SigningRefusal(409, `${found.label}尚未完成簽署，沒有可保存的文件`);
        }
        return found;
      });
      return saveTaskFiles(ctx, subject, subscriber, options);
    },

    // 文件紀錄，含保存失敗的原因
    async listFiles(subject: SigningSubject): Promise<SignTaskFile[]> {
      const ctx = await db.requestOrg();
      return db.inOrg(ctx, async (tx) => {
        const task = await findSignTask(tx, subject);
        return task ? listSignTaskFiles(tx, task.id) : [];
      });
    },

    // 兩份文件都只在完成後存在。沒保存到就當場補抓一次再回檔案。
    async downloadFile(subject: SigningSubject, kind: ContractFileKind): Promise<DownloadedFile> {
      const ctx = await db.requestOrg();
      const label = CONTRACT_FILE_LABELS[kind];
      const { subscriber, task, file } = await db.inOrg(ctx, async (tx) => {
        const subscriber = await requireSubscriber(tx, subject);
        if (!(await subscriber.isCompleted(tx, subject))) {
          throw new SigningRefusal(409, `${subscriber.label}尚未完成簽署，${label}尚未產生`);
        }
        refuseIfUnsupported(provider.unsupported.files?.[kind], 409);
        const task = await findSignTask(tx, subject);
        if (!task) throw new SigningRefusal(409, `${subscriber.label}沒有對應的簽署任務，無法取得${label}`);
        return { subscriber, task, file: await getSignTaskFile(tx, task.id, kind) };
      });

      const saved = await readSavedFile(file);
      if (saved) return saved;
      const results = await saveTaskFiles(ctx, subject, subscriber, { kinds: [kind], force: true });
      const refetched = await readSavedFile(await db.inOrg(ctx, (tx) => getSignTaskFile(tx, task.id, kind)));
      if (refetched) return refetched;
      const failure = results.find((r) => r.kind === kind)?.error ?? '未知原因';
      throw new SigningRefusal(502, `取得${label}失敗：${failure}`);
    },
  };

  // 處理一列 inbox：認領（control 交易）、套用事件與標記完成（組織交易）、提交後的收尾。
  // 認領時依路由列查出組織。路由列還不存在（建立任務的交易尚未提交）時，這一列留到下次重試。
  // 事件的效果與「已處理」同一個組織交易提交，不會只做一半。
  async function processInbox(inboxId: string): Promise<InboxResult> {
    const claim = await db.inControl(async (tx) => {
      const row = await claimInbox(tx, inboxId);
      if (!row) return null;
      const route = await findSignTaskRoute(tx, row.provider, row.taskRef);
      if (route) return { kind: 'routed' as const, row, orgId: route.orgId };
      const reason = '找不到路由列，建立簽署任務的交易可能還沒提交';
      return { kind: 'deferred' as const, row, reason, status: await failInbox(tx, row, reason) };
    });
    if (!claim) return { kind: 'not_claimed' };
    if (claim.kind === 'deferred') {
      console.info(`[signing] 簽署事件 ${claim.row.event.type} 暫存：對不到簽署任務 ${claim.row.taskRef}（${claim.status}）`);
      return { kind: 'deferred', reason: claim.reason, status: claim.status };
    }

    const { row } = claim;
    const ctx: OrgContext = { kind: 'org', orgId: claim.orgId };
    try {
      // 事件進交易之前的準備（MIL-70）：先找出簽署標的，準備在交易外做
      const target = await db.inOrg(ctx, async (tx) => {
        const task = await findSignTaskByRef(tx, row.provider, row.taskRef);
        const found = task && subscribers[task.subject.type];
        return task && found ? { subject: task.subject, subscriber: found } : null;
      });
      const prep = target ? await prepareEvent(ctx, target.subject, target.subscriber, row.event) : undefined;
      const applied = await db.inOrg(ctx, async (tx) => {
        const task = await findSignTaskByRef(tx, row.provider, row.taskRef);
        const subscriber = task && subscribers[task.subject.type];
        if (!task || !subscriber || !(await subscriber.exists(tx, task.subject))) {
          console.info(`[signing] 忽略簽署事件 ${row.event.type}：對不到簽署任務 ${row.taskRef}`);
          await finishInbox(tx, row.id, { status: 'ignored', note: '對不到簽署任務' });
          return null;
        }
        const outcome = await applyEventTx(tx, task.subject, subscriber, row.event, prep);
        // 不接受的事件（重複、亂序、email 不符）也標為已處理：重試不會讓它變得可接受
        await finishInbox(tx, row.id, outcome ? { status: 'done' } : { status: 'ignored', note: '事件不需要套用' });
        return { subject: task.subject, subscriber, outcome };
      });
      if (!applied) return { kind: 'ignored', reason: '對不到簽署任務' };
      // 提交後的收尾是外部 IO，失敗不回滾也不重試事件。文件之後可補抓
      try {
        await finishAfterCommit(ctx, applied.subject, applied.subscriber, applied.outcome);
      } catch (e) {
        console.error(`[signing] 簽署事件已套用，但收尾失敗：${errorMessage(e)}`);
      }
      return applied.outcome ? { kind: 'done' } : { kind: 'ignored', reason: '事件不需要套用' };
    } catch (e) {
      const error = errorMessage(e);
      console.error(`[signing] 處理簽署事件 ${row.id} 失敗：${error}`);
      const status = await db.inControl((tx) => failInbox(tx, row, error));
      return { kind: 'failed', error, status };
    }
  }

  // 處理失敗不往外拋：webhook 已經寫入 inbox，該回 2xx。連失敗都記不下來時，列停在 processing，期限到了由排程接手
  async function processInboxSafely(inboxId: string): Promise<InboxResult> {
    try {
      return await processInbox(inboxId);
    } catch (e) {
      const error = errorMessage(e);
      console.error(`[signing] 處理 inbox ${inboxId} 時發生非預期錯誤：${error}`);
      return { kind: 'failed', error, status: 'processing' };
    }
  }

  // 建立簽署任務失敗的記錄。寫不進去時只記 log，不蓋掉原本的錯誤
  async function markCreateFailed(
    ctx: OrgContext,
    outbox: Pick<OutboxRow, 'id' | 'action' | 'attempts'>,
    error: string,
    providerTaskRef?: string
  ): Promise<void> {
    try {
      await db.inOrg(ctx, (tx) => failOutbox(tx, outbox, error, providerTaskRef));
    } catch (e) {
      console.error(`[signing] 記錄建立簽署任務失敗時出錯：${errorMessage(e)}`);
    }
  }
}

const PDF = 'application/pdf';

// 檔名由簽署標的推導，例：contract-<ULID>-signed.pdf
function fileNameOf(subject: SigningSubject, kind: ContractFileKind): string {
  return `${subject.type}-${subject.id}-${FILE_SUFFIX[kind]}.pdf`;
}

function describeSubject(subject: SigningSubject, subscriber: SigningSubscriber): string {
  return `${subscriber.label} ${subject.id} `;
}

function logFailure(
  subject: SigningSubject,
  subscriber: SigningSubscriber,
  kind: ContractFileKind,
  error: string
): SaveFileResult {
  console.error(`[signing] ${describeSubject(subject, subscriber)}的${CONTRACT_FILE_LABELS[kind]}保存失敗：${error}`);
  return { kind, ok: false, error };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type SigningModule = ReturnType<typeof createSigningModule>;

// route handler 共用的錯誤回應：模組拒絕時用它給的狀態碼，其他失敗視為服務商錯誤
export function signingErrorResponse(e: unknown, fallbackMessage: string): Response {
  if (e instanceof SigningRefusal) return jsonError(e.status, e.message);
  // 模組開交易要組織脈絡。沒登入或不是組織身分時，和其他組織 route 的回應一致
  if (e instanceof Unauthenticated) return jsonError(401, e.message);
  if (e instanceof OrgContextRequired) return jsonError(403, e.message);
  return jsonError(502, e instanceof Error ? e.message : fallbackMessage);
}

function refuseIfUnsupported(reason: string | undefined, status: number): void {
  if (reason) throw new SigningRefusal(status, reason);
}

// 同一簽署任務內 email 不得重複：email 守門靠它分辨重試與下一位的簽署（ADR-0010 決議 9）
function refuseInvalidSequence(signers: Signer[]): void {
  if (signers.length === 0) throw new SigningRefusal(400, '簽署序列不得為空');
  const seen = new Set<string>();
  for (const { email } of signers) {
    const key = normalizeEmail(email);
    if (seen.has(key)) {
      throw new SigningRefusal(400, `簽署人的 email 重複：${email}。每位簽署人必須使用不同的 email，請修正後再送簽。`);
    }
    seen.add(key);
  }
}

async function requireCurrentSigner(
  tx: OrgTx,
  subject: SigningSubject,
  subscriber: SigningSubscriber
): Promise<{ signer: CurrentSigner; taskRef: string }> {
  const task = await findSignTask(tx, subject);
  const signer = task && currentSignerOf(task);
  if (!signer) throw new SigningRefusal(409, `${subscriber.label}不在簽署中，沒有待簽方`);
  return { signer, taskRef: task.taskRef };
}

const typeOfEvent = (event: SigningEvent | ((task: SignTaskRecord) => SigningEvent)): string =>
  typeof event === 'function' ? 'mock' : event.type;

// 只記理由與事件種類。email 是個資，不寫進 log。
function logIgnored(subject: SigningSubject, eventType: string, reason: string): null {
  console.info(`[signing] 忽略簽署事件 ${eventType}：${subject.type} ${subject.id}，${reason}`);
  return null;
}

// 準備失敗不得擋下簽署進度：簽署已經發生，法律事實優先（ADR-0018 決議 11）
async function prepareOutcome(
  subject: SigningSubject,
  subscriber: SigningSubscriber,
  event: SigningEvent,
  eventAt: string,
  read: ReadInOrg
): Promise<unknown> {
  if (!subscriber.prepareOutcome) return undefined;
  try {
    return await subscriber.prepareOutcome(subject, event, eventAt, read);
  } catch (e) {
    console.error(`[signing] ${subject.type} ${subject.id} 簽署事件的準備失敗：${errorMessage(e)}`);
    return undefined;
  }
}

// 事件提交後的處理（例如自動撤回）失敗不得讓 webhook 回非 2xx，否則點點簽重試會累積到暫停 webhook
async function runAfterOutcome(
  subject: SigningSubject,
  subscriber: SigningSubscriber,
  outcome: ProgressOutcome,
  tools: AfterOutcomeTools
): Promise<void> {
  if (!subscriber.afterOutcome) return;
  try {
    await subscriber.afterOutcome(subject, outcome, tools);
  } catch (e) {
    console.error(`[signing] ${subject.type} ${subject.id} 簽署事件後的處理失敗：${errorMessage(e)}`);
  }
}

// 訂閱者完成後的處理失敗不得讓 webhook 回非 2xx（MIL-52）
async function runAfterCompleted(subject: SigningSubject, subscriber: SigningSubscriber): Promise<void> {
  try {
    await subscriber.afterCompleted(subject);
  } catch (e) {
    console.error(`[signing] ${subject.type} ${subject.id} 完成後的處理失敗：${errorMessage(e)}`);
  }
}

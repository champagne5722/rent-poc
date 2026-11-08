import fs from 'fs';
import path from 'path';
import { getDb } from '../db';
import { CONTRACT_FILE_KINDS, CONTRACT_FILE_LABELS } from '../types';
import type { ContractFileKind } from '../types';
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
  findSubjectByTaskRef,
  insertSignTask,
  saveProgress,
  toSigningProgress,
  type SigningProgress,
} from './sign-task-store';
import { SigningRefusal, type SendContext, type SigningSubscriber } from './subscriber';

// 簽署模組（ADR-0010）：route handler 只呼叫這裡，服務商細節都在 adapter，
// 業務實體的細節都在訂閱者。介面一律回傳 Promise，呼叫端看不到服務商任務編號。

export { SigningRefusal } from './subscriber';

// 平台的簽署任務
export interface SignTask {
  subject: SigningSubject;
  mode: SigningProvider['mode'];
}

// webhook 的回應碼與回應內容
export interface WebhookAck {
  status: number;
  body: { ok: true; ping?: true; ignored?: true } | { error: string };
}

// mock advance 可模擬的簽署事件。撤回有自己的操作。
const SIMULATABLE_EVENTS: readonly SigningEventType[] = ['signed', 'completed', 'declined'];

export interface SigningModuleDeps {
  provider: SigningProvider;
  // 以 subject.type 為鍵
  subscribers: Record<string, SigningSubscriber>;
  // 文件本體的根目錄。文件紀錄的 rel_path 相對這裡，正式執行時是 data/。
  dataDir: string;
  // 模擬簽署事件（mock advance）的事件時間來源。真實 webhook 的事件時間由服務商提供。
  now?: () => Date;
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

// 下載端點回給使用者的文件
export interface DownloadedFile {
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

// 新保存的文件放在 sign-task-files/<簽署任務 id>/。回填前的文件留在 contract-files/<合約 id>/，不搬。
const FILES_DIR = 'sign-task-files';
const FILE_SUFFIX: Record<ContractFileKind, string> = { signed_pdf: 'signed', audit_trail: 'audit-trail' };

export function createSigningModule({ provider, subscribers, dataDir, now = () => new Date() }: SigningModuleDeps) {
  function requireSubscriber(subject: SigningSubject): SigningSubscriber {
    const subscriber = subscribers[subject.type];
    if (!subscriber) throw new SigningRefusal(404, '不支援的簽署標的');
    if (!subscriber.exists(subject)) throw new SigningRefusal(404, `${subscriber.label}不存在`);
    return subscriber;
  }

  // webhook、撤回與 mock advance 共用這條路徑，確保模擬與真接行為一致。
  // 簽署進度、狀態與歷程同交易寫入（ADR-0007、ADR-0010 決議 8）。
  // 不接受的事件回 null 並記 log。保存文件與訂閱者的完成後處理都是外部 IO，
  // 放在交易提交之後，失敗不回滾狀態。
  async function applyEvent(
    subject: SigningSubject,
    subscriber: SigningSubscriber,
    event: SigningEvent
  ): Promise<ProgressOutcome | null> {
    const db = getDb();
    // 事件時間：服務商提供的優先，沒有時用現在時間。訂閱者的判定用它，不用系統收到事件的時間。
    const eventAt = event.occurredAt ?? now().toISOString();
    const prepared = await prepareOutcome(subject, subscriber, event, eventAt);
    const outcome = db.transaction(() => {
      const task = findSignTask(db, subject);
      if (!task) return logIgnored(subject, event, 'no_task');
      const advance = advanceProgress(task, event);
      if (!advance.accepted) return logIgnored(subject, event, advance.reason);
      saveProgress(db, task, advance);
      subscriber.onOutcome(subject, advance.outcome, { eventAt, prepared });
      return advance.outcome;
    })();
    if (outcome?.type === 'completed') {
      await saveFilesOnCompleted(subject, subscriber);
      await runAfterCompleted(subject, subscriber);
    }
    return outcome;
  }

  // 刻意不讓例外往外拋：webhook 回非 2xx 會被點點簽重試，
  // 單日累積 10 次投遞失敗會停掉整個 application 的 webhook。失敗的種類之後可補抓。
  async function saveFilesOnCompleted(subject: SigningSubject, subscriber: SigningSubscriber): Promise<void> {
    try {
      await saveTaskFiles(subject, subscriber, {});
    } catch (e) {
      console.error(`[signing] ${describeSubject(subject, subscriber)}完成時保存文件失敗：${errorMessage(e)}`);
    }
  }

  // 服務商沒有的種類不保存。沒帶 force 時，已保存的種類不重抓。
  async function saveTaskFiles(
    subject: SigningSubject,
    subscriber: SigningSubscriber,
    options: SaveFilesOptions
  ): Promise<SaveFileResult[]> {
    const db = getDb();
    const kinds = (options.kinds ?? CONTRACT_FILE_KINDS).filter((kind) => !provider.unsupported.files?.[kind]);
    const task = findSignTask(db, subject);
    if (!task) {
      return kinds.map((kind) => logFailure(subject, subscriber, kind, `${subscriber.label}沒有對應的簽署任務`));
    }

    const results: SaveFileResult[] = [];
    for (const kind of kinds) {
      if (!options.force && getSignTaskFile(db, task.id, kind)?.status === 'saved') continue;
      const fileName = fileNameOf(subject, kind);
      try {
        const bytes = await provider.downloadFile(task.taskRef, kind);
        const relPath = path.posix.join(FILES_DIR, String(task.id), fileName);
        const absPath = path.join(dataDir, relPath);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, bytes);
        upsertSignTaskFile(db, task.id, {
          kind,
          status: 'saved',
          file_name: fileName,
          rel_path: relPath,
          byte_size: bytes.length,
          content_type: PDF,
          error: null,
        });
        results.push({ kind, ok: true });
      } catch (e) {
        const error = errorMessage(e);
        upsertSignTaskFile(db, task.id, {
          kind,
          status: 'failed',
          file_name: fileName,
          rel_path: null,
          byte_size: null,
          content_type: null,
          error,
        });
        results.push(logFailure(subject, subscriber, kind, error));
      }
    }
    return results;
  }

  // 檔案被刪掉時視為未保存，交給呼叫端補抓
  function readSavedFile(signTaskId: number, kind: ContractFileKind): DownloadedFile | null {
    const file = getSignTaskFile(getDb(), signTaskId, kind);
    if (!file || file.status !== 'saved' || !file.rel_path) return null;
    const absPath = path.join(dataDir, file.rel_path);
    if (!fs.existsSync(absPath)) return null;
    return {
      fileName: file.file_name,
      contentType: file.content_type ?? PDF,
      bytes: new Uint8Array(fs.readFileSync(absPath)),
    };
  }

  return {
    mode: async () => provider.mode,

    // context 是業務資料，原樣交給訂閱者的 onSent，在同一個交易內使用（MIL-70）
    async send(
      subject: SigningSubject,
      document: SignableDocument,
      signers: Signer[],
      context?: SendContext
    ): Promise<SignTask> {
      const subscriber = requireSubscriber(subject);
      refuseInvalidSequence(signers);
      const db = getDb();
      // 先擋下來，才不會在服務商多建一個用不到的任務
      if (findSignTask(db, subject)) throw new SigningRefusal(409, '這個簽署標的已有簽署任務');
      const { taskRef } = await provider.createTask({ subject, document, signers });
      db.transaction(() => {
        // 訊息會回給呼叫端，所以不帶服務商任務編號
        if (!insertSignTask(db, { provider: provider.id, taskRef, subject, signers })) {
          throw new SigningRefusal(409, '簽署標的或服務商任務編號已有簽署任務');
        }
        subscriber.onSent(subject, { signers, context });
      })();
      return { subject, mode: provider.mode };
    },

    async getProgress(subject: SigningSubject): Promise<SigningProgress | null> {
      const task = findSignTask(getDb(), subject);
      return task ? toSigningProgress(task) : null;
    },

    async getSignLink(subject: SigningSubject, redirectUrl?: string): Promise<{ signer: CurrentSigner; url: string }> {
      const subscriber = requireSubscriber(subject);
      refuseIfUnsupported(provider.unsupported.signLink, 409);
      const { signer, taskRef } = requireCurrentSigner(subject, subscriber);
      return { signer, url: await provider.getSignLink(taskRef, signer.email, redirectUrl) };
    },

    async resend(subject: SigningSubject): Promise<{ signer: CurrentSigner }> {
      const subscriber = requireSubscriber(subject);
      refuseIfUnsupported(provider.unsupported.resend, 409);
      const { signer, taskRef } = requireCurrentSigner(subject, subscriber);
      await provider.resend(taskRef);
      return { signer };
    },

    // 呼叫服務商期間可能收到全員完成事件。applyEvent 會在交易內重讀進度，
    // 所以這時撤回不接受並回 409，已完成的簽署標的不會被改成已撤回。
    async voidTask(subject: SigningSubject): Promise<void> {
      const subscriber = requireSubscriber(subject);
      const task = findSignTask(getDb(), subject);
      if (!task) return subscriber.voidWithoutTask(subject);
      if (task.status !== 'in_progress') throw new SigningRefusal(409, `僅簽署中的${subscriber.label}可撤回`);
      await provider.voidTask(task.taskRef);
      const outcome = await applyEvent(subject, subscriber, { type: 'voided' });
      if (!outcome) throw new SigningRefusal(409, `僅簽署中的${subscriber.label}可撤回`);
    },

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
          const subject = findSubjectByTaskRef(getDb(), provider.id, parsed.taskRef);
          const subscriber = subject && subscribers[subject.type];
          if (!subject || !subscriber?.exists(subject)) {
            console.info(`[signing] 忽略簽署事件 ${parsed.event.type}：對不到簽署任務 ${parsed.taskRef}`);
            return ignored;
          }
          // 不接受的事件也回 2xx：非 2xx 會被重試，累積後整個 application 的 webhook 會被暫停
          const outcome = await applyEvent(subject, subscriber, parsed.event);
          return outcome ? { status: 200, body: { ok: true } } : ignored;
        }
      }
    },

    // 不經 webhook 模擬簽署事件。event 與 reason 來自未驗證的請求 body，這裡才檢查。
    // 模擬的簽署人已簽一律是當前簽署人。模擬事件沒有服務商，事件時間取現在。
    async simulateEvent(subject: SigningSubject, event: unknown, reason?: unknown): Promise<{ status: string }> {
      refuseIfUnsupported(provider.unsupported.simulate, 403);
      const subscriber = requireSubscriber(subject);
      if (!SIMULATABLE_EVENTS.includes(event as SigningEventType)) {
        throw new SigningRefusal(400, '不支援的事件');
      }
      const task = findSignTask(getDb(), subject);
      const outcome = await applyEvent(subject, subscriber, {
        type: event as SigningEventType,
        email: task ? currentSignerOf(task)?.email : undefined,
        reason: typeof reason === 'string' ? reason : undefined,
        occurredAt: now().toISOString(),
      });
      if (!outcome) throw new SigningRefusal(409, `目前狀態（${subscriber.currentStatus(subject)}）不接受此事件`);
      return { status: subscriber.currentStatus(subject) };
    },

    // 補抓文件。完成當下保存失敗（服務商暫時性錯誤、連結過期等）時的補救手段。
    async saveFiles(
      subject: SigningSubject,
      options: SaveFilesOptions = {}
    ): Promise<SaveFileResult[]> {
      const subscriber = requireSubscriber(subject);
      if (!subscriber.isCompleted(subject)) {
        throw new SigningRefusal(409, `${subscriber.label}尚未完成簽署，沒有可保存的文件`);
      }
      return saveTaskFiles(subject, subscriber, options);
    },

    // 文件紀錄，含保存失敗的原因
    async listFiles(subject: SigningSubject): Promise<SignTaskFile[]> {
      const task = findSignTask(getDb(), subject);
      return task ? listSignTaskFiles(getDb(), task.id) : [];
    },

    // 兩份文件都只在完成後存在。沒保存到就當場補抓一次再回檔案。
    async downloadFile(subject: SigningSubject, kind: ContractFileKind): Promise<DownloadedFile> {
      const subscriber = requireSubscriber(subject);
      const label = CONTRACT_FILE_LABELS[kind];
      if (!subscriber.isCompleted(subject)) {
        throw new SigningRefusal(409, `${subscriber.label}尚未完成簽署，${label}尚未產生`);
      }
      refuseIfUnsupported(provider.unsupported.files?.[kind], 409);
      const task = findSignTask(getDb(), subject);
      if (!task) throw new SigningRefusal(409, `${subscriber.label}沒有對應的簽署任務，無法取得${label}`);

      const saved = readSavedFile(task.id, kind);
      if (saved) return saved;
      const results = await saveTaskFiles(subject, subscriber, { kinds: [kind], force: true });
      const refetched = readSavedFile(task.id, kind);
      if (refetched) return refetched;
      const failure = results.find((r) => r.kind === kind)?.error ?? '未知原因';
      throw new SigningRefusal(502, `取得${label}失敗：${failure}`);
    },
  };
}

const PDF = 'application/pdf';

// 檔名由簽署標的推導，例：contract-12-signed.pdf
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
  if (e instanceof SigningRefusal) return Response.json({ error: e.message }, { status: e.status });
  return Response.json({ error: e instanceof Error ? e.message : fallbackMessage }, { status: 502 });
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

function requireCurrentSigner(
  subject: SigningSubject,
  subscriber: SigningSubscriber
): { signer: CurrentSigner; taskRef: string } {
  const task = findSignTask(getDb(), subject);
  const signer = task && currentSignerOf(task);
  if (!signer) throw new SigningRefusal(409, `${subscriber.label}不在簽署中，沒有待簽方`);
  return { signer, taskRef: task.taskRef };
}

// 只記理由與事件種類。email 是個資，不寫進 log。
function logIgnored(subject: SigningSubject, event: SigningEvent, reason: string): null {
  console.info(`[signing] 忽略簽署事件 ${event.type}：${subject.type} ${subject.id}，${reason}`);
  return null;
}

// 準備失敗不得擋下簽署進度：簽署已經發生，法律事實優先（ADR-0018 決議 11）
async function prepareOutcome(
  subject: SigningSubject,
  subscriber: SigningSubscriber,
  event: SigningEvent,
  eventAt: string
): Promise<unknown> {
  if (!subscriber.prepareOutcome) return undefined;
  try {
    return await subscriber.prepareOutcome(subject, event, eventAt);
  } catch (e) {
    console.error(`[signing] ${subject.type} ${subject.id} 簽署事件的準備失敗：${errorMessage(e)}`);
    return undefined;
  }
}

// 訂閱者完成後的處理失敗不得讓 webhook 回非 2xx（MIL-52）
async function runAfterCompleted(subject: SigningSubject, subscriber: SigningSubscriber): Promise<void> {
  try {
    await subscriber.afterCompleted(subject);
  } catch (e) {
    console.error(`[signing] ${subject.type} ${subject.id} 完成後的處理失敗：${e instanceof Error ? e.message : e}`);
  }
}

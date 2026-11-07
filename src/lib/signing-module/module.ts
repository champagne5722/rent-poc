import fs from 'fs';
import path from 'path';
import { commitTransition, getContract, getDb } from '../db';
import { currentSigner } from '../signing';
import { applyDsEvent } from '../transitions';
import { CONTRACT_FILE_KINDS, CONTRACT_FILE_LABELS } from '../types';
import type { Contract, ContractFileKind, ContractStatus } from '../types';
import { getSignTaskFile, listSignTaskFiles, upsertSignTaskFile, type SignTaskFile } from './sign-task-files';
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
import {
  currentSignerOf,
  findSignTask,
  findSubjectByTaskRef,
  insertSignTask,
  recordSigningEvent,
  toSigningProgress,
  type SigningProgress,
} from './sign-task-store';

// 簽署模組（ADR-0010）：route handler 只呼叫這裡，服務商細節都在 adapter。
// 介面一律回傳 Promise，呼叫端看不到服務商任務編號。

// 平台的簽署任務
export interface SignTask {
  subject: SigningSubject;
  mode: SigningProvider['mode'];
}

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

// webhook 的回應碼與回應內容
export interface WebhookAck {
  status: number;
  body: { ok: true; ping?: true; ignored?: true } | { error: string };
}

// mock advance 可模擬的簽署事件。撤回有自己的操作。
const SIMULATABLE_EVENTS: readonly SigningEventType[] = ['signed', 'completed', 'declined'];

export interface SigningModuleDeps {
  provider: SigningProvider;
  // 文件本體的根目錄。文件紀錄的 rel_path 相對這裡，正式執行時是 data/。
  dataDir: string;
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

export function createSigningModule({ provider, dataDir }: SigningModuleDeps) {
  // webhook 與 mock advance 共用這條路徑，確保模擬與真接行為一致。
  // 簽署進度、狀態與歷程同交易寫入（ADR-0007、ADR-0010 決議 8）。
  // 保存文件是外部 IO，放在交易提交之後，失敗不回滾狀態。
  async function applyEvent(contract: Contract, event: SigningEvent): Promise<ContractStatus | null> {
    const db = getDb();
    const subject: SigningSubject = { type: 'contract', id: contract.id };
    const next = db.transaction(() => {
      const status = applyDsEvent(contract, event.type, event.reason, db);
      if (status) recordSigningEvent(db, subject, event.type);
      return status;
    })();
    if (next === 'completed') await saveFilesOnCompleted(subject);
    return next;
  }

  // 刻意不讓例外往外拋：webhook 回非 2xx 會被點點簽重試，
  // 單日累積 10 次投遞失敗會停掉整個 application 的 webhook。失敗的種類之後可補抓。
  async function saveFilesOnCompleted(subject: SigningSubject): Promise<void> {
    try {
      await saveTaskFiles(subject, {});
    } catch (e) {
      console.error(`[signing] ${describeSubject(subject)}完成時保存文件失敗：${errorMessage(e)}`);
    }
  }

  // 服務商沒有的種類不保存。沒帶 force 時，已保存的種類不重抓。
  async function saveTaskFiles(
    subject: SigningSubject,
    options: SaveFilesOptions
  ): Promise<SaveFileResult[]> {
    const db = getDb();
    const kinds = (options.kinds ?? CONTRACT_FILE_KINDS).filter((kind) => !provider.unsupported.files?.[kind]);
    const task = findSignTask(db, subject);
    if (!task) return kinds.map((kind) => logFailure(subject, kind, '合約沒有對應的簽署任務'));

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
        results.push(logFailure(subject, kind, error));
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

    // 服務商任務編號仍雙寫到合約的欄位，send route 的 task_id 回應還在讀，移除屬 MIL-60。狀態機仍是兩位簽署人。
    async send(subject: SigningSubject, document: SignableDocument, signers: Signer[]): Promise<SignTask> {
      const contract = requireContract(subject);
      const db = getDb();
      // 先擋下來，才不會在服務商多建一個用不到的任務
      if (findSignTask(db, subject)) throw new SigningRefusal(409, '這個簽署標的已有簽署任務');
      const { taskRef } = await provider.createTask({ subject, document, signers });
      // 簽署任務、狀態與「送簽」歷程事件同交易寫入（ADR-0007、ADR-0010 決議 8）
      db.transaction(() => {
        // 訊息會回給呼叫端，所以不帶服務商任務編號
        if (!insertSignTask(db, { provider: provider.id, taskRef, subject, signers })) {
          throw new SigningRefusal(409, '簽署標的或服務商任務編號已有簽署任務');
        }
        commitTransition(
          contract.id,
          {
            status: 'awaiting_tenant',
            event: { type: 'sent', actor: 'landlord', note: `寄送給乙方 ${signers[0].email}` },
            dottedsignTaskId: taskRef,
          },
          db
        );
      })();
      return { subject, mode: provider.mode };
    },

    async getProgress(subject: SigningSubject): Promise<SigningProgress | null> {
      const task = findSignTask(getDb(), subject);
      return task ? toSigningProgress(task) : null;
    },

    async getSignLink(subject: SigningSubject, redirectUrl?: string): Promise<{ signer: CurrentSigner; url: string }> {
      requireContract(subject);
      refuseIfUnsupported(provider.unsupported.signLink, 409);
      const { signer, taskRef } = requireCurrentSigner(subject);
      return { signer, url: await provider.getSignLink(taskRef, signer.email, redirectUrl) };
    },

    async resend(subject: SigningSubject): Promise<{ signer: CurrentSigner }> {
      requireContract(subject);
      refuseIfUnsupported(provider.unsupported.resend, 409);
      const { signer, taskRef } = requireCurrentSigner(subject);
      await provider.resend(taskRef);
      return { signer };
    },

    // 簽署中的判斷看合約狀態：簽署中卻沒有任務編號的舊合約沒有簽署任務，仍要能撤回。
    async voidTask(subject: SigningSubject): Promise<void> {
      const contract = requireContract(subject);
      if (!currentSigner(contract)) throw new SigningRefusal(409, '僅簽署中的合約可撤回');
      const task = findSignTask(getDb(), subject);
      if (task) await provider.voidTask(task.taskRef);
      await applyEvent(contract, { type: 'voided' });
    },

    async ingestWebhook(rawBody: string, headers: WebhookHeaders): Promise<WebhookAck> {
      const parsed = provider.parseWebhook(rawBody, headers);
      switch (parsed.kind) {
        case 'ping':
          return { status: 200, body: { ok: true, ping: true } };
        case 'ignored':
          return { status: 200, body: { ok: true, ignored: true } };
        case 'invalid':
          return { status: parsed.status, body: { error: parsed.reason } };
        case 'event': {
          const subject = findSubjectByTaskRef(getDb(), provider.id, parsed.taskRef);
          const contract = subject && getContract(subject.id);
          if (!contract) return { status: 200, body: { ok: true, ignored: true } };
          // 不接受的事件也回 2xx：非 2xx 會被重試，累積後整個 application 的 webhook 會被暫停
          await applyEvent(contract, parsed.event);
          return { status: 200, body: { ok: true } };
        }
      }
    },

    // 不經 webhook 模擬簽署事件。event 與 reason 來自未驗證的請求 body，這裡才檢查。
    async simulateEvent(subject: SigningSubject, event: unknown, reason?: unknown): Promise<{ status: ContractStatus }> {
      refuseIfUnsupported(provider.unsupported.simulate, 403);
      const contract = requireContract(subject);
      if (!SIMULATABLE_EVENTS.includes(event as SigningEventType)) {
        throw new SigningRefusal(400, '不支援的事件');
      }
      const next = await applyEvent(contract, {
        type: event as SigningEventType,
        reason: typeof reason === 'string' ? reason : undefined,
      });
      if (!next) throw new SigningRefusal(409, `目前狀態（${contract.status}）不接受此事件`);
      return { status: next };
    },

    // 補抓文件。完成當下保存失敗（服務商暫時性錯誤、連結過期等）時的補救手段。
    async saveFiles(
      subject: SigningSubject,
      options: SaveFilesOptions = {}
    ): Promise<SaveFileResult[]> {
      const contract = requireContract(subject);
      if (contract.status !== 'completed') throw new SigningRefusal(409, '合約尚未完成簽署，沒有可保存的文件');
      return saveTaskFiles(subject, options);
    },

    // 文件紀錄，含保存失敗的原因
    async listFiles(subject: SigningSubject): Promise<SignTaskFile[]> {
      const task = findSignTask(getDb(), subject);
      return task ? listSignTaskFiles(getDb(), task.id) : [];
    },

    // 兩份文件都只在完成後存在。沒保存到就當場補抓一次再回檔案。
    async downloadFile(subject: SigningSubject, kind: ContractFileKind): Promise<DownloadedFile> {
      const contract = requireContract(subject);
      const label = CONTRACT_FILE_LABELS[kind];
      if (contract.status !== 'completed') throw new SigningRefusal(409, `合約尚未完成簽署，${label}尚未產生`);
      refuseIfUnsupported(provider.unsupported.files?.[kind], 409);
      const task = findSignTask(getDb(), subject);
      if (!task) throw new SigningRefusal(409, `合約沒有對應的簽署任務，無法取得${label}`);

      const saved = readSavedFile(task.id, kind);
      if (saved) return saved;
      const results = await saveTaskFiles(subject, { kinds: [kind], force: true });
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

function describeSubject(subject: SigningSubject): string {
  return subject.type === 'contract' ? `合約 ${subject.id} ` : `${subject.type} ${subject.id} `;
}

function logFailure(subject: SigningSubject, kind: ContractFileKind, error: string): SaveFileResult {
  console.error(`[signing] ${describeSubject(subject)}的${CONTRACT_FILE_LABELS[kind]}保存失敗：${error}`);
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

function requireContract(subject: SigningSubject): Contract {
  const contract = getContract(subject.id);
  if (!contract) throw new SigningRefusal(404, '合約不存在');
  return contract;
}

function requireCurrentSigner(subject: SigningSubject): { signer: CurrentSigner; taskRef: string } {
  const task = findSignTask(getDb(), subject);
  const signer = task && currentSignerOf(task);
  if (!signer) throw new SigningRefusal(409, '合約不在簽署中，沒有待簽方');
  return { signer, taskRef: task.taskRef };
}

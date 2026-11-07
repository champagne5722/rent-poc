import { commitTransition, getContract, getDb } from '../db';
import { currentSigner } from '../signing';
import { applyDsEvent } from '../transitions';
import type { Contract, ContractStatus } from '../types';
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
  // 全員完成後保存文件。文件保存移進模組前的掛點，不得拋例外。
  onCompleted: (contract: Contract) => Promise<void>;
}

export function createSigningModule({ provider, onCompleted }: SigningModuleDeps) {
  // webhook 與 mock advance 共用這條路徑，確保模擬與真接行為一致。
  // 簽署進度、狀態與歷程同交易寫入（ADR-0007、ADR-0010 決議 8）。
  // 保存文件是外部 IO，放在交易之外，失敗不回滾狀態。
  async function applyEvent(contract: Contract, event: SigningEvent): Promise<ContractStatus | null> {
    const db = getDb();
    const next = db.transaction(() => {
      const status = applyDsEvent(contract, event.type, event.reason, db);
      if (status) recordSigningEvent(db, { type: 'contract', id: contract.id }, event.type);
      return status;
    })();
    if (next === 'completed') await onCompleted(contract);
    return next;
  }

  return {
    mode: async () => provider.mode,

    // 服務商任務編號仍雙寫到合約的欄位，留給文件保存那張票讀取。狀態機仍是兩位簽署人。
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
  };
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

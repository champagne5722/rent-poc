import { getDb } from '../db';
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
import {
  currentSignerOf,
  findSignTask,
  findSubjectByTaskRef,
  insertSignTask,
  saveProgress,
  toSigningProgress,
  type SigningProgress,
} from './sign-task-store';
import { SigningRefusal, type SigningSubscriber } from './subscriber';

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
}

export function createSigningModule({ provider, subscribers }: SigningModuleDeps) {
  function requireSubscriber(subject: SigningSubject): SigningSubscriber {
    const subscriber = subscribers[subject.type];
    if (!subscriber) throw new SigningRefusal(404, '不支援的簽署標的');
    if (!subscriber.exists(subject)) throw new SigningRefusal(404, `${subscriber.label}不存在`);
    return subscriber;
  }

  // webhook、撤回與 mock advance 共用這條路徑，確保模擬與真接行為一致。
  // 簽署進度、狀態與歷程同交易寫入（ADR-0007、ADR-0010 決議 8）。
  // 不接受的事件回 null 並記 log。保存文件是外部 IO，放在交易之外，失敗不回滾狀態。
  async function applyEvent(
    subject: SigningSubject,
    subscriber: SigningSubscriber,
    event: SigningEvent
  ): Promise<ProgressOutcome | null> {
    const db = getDb();
    const outcome = db.transaction(() => {
      const task = findSignTask(db, subject);
      if (!task) return logIgnored(subject, event, 'no_task');
      const advance = advanceProgress(task, event);
      if (!advance.accepted) return logIgnored(subject, event, advance.reason);
      saveProgress(db, task, advance);
      subscriber.onOutcome(subject, advance.outcome);
      return advance.outcome;
    })();
    if (outcome?.type === 'completed') await runAfterCompleted(subject, subscriber);
    return outcome;
  }

  return {
    mode: async () => provider.mode,

    async send(subject: SigningSubject, document: SignableDocument, signers: Signer[]): Promise<SignTask> {
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
        subscriber.onSent(subject, { taskRef, signers });
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
    // 模擬的簽署人已簽一律是當前簽署人。
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
      });
      if (!outcome) throw new SigningRefusal(409, `目前狀態（${subscriber.currentStatus(subject)}）不接受此事件`);
      return { status: subscriber.currentStatus(subject) };
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

// 文件保存失敗不得讓 webhook 回非 2xx（MIL-52）
async function runAfterCompleted(subject: SigningSubject, subscriber: SigningSubscriber): Promise<void> {
  try {
    await subscriber.afterCompleted(subject);
  } catch (e) {
    console.error(`[signing] ${subject.type} ${subject.id} 完成後的處理失敗：${e instanceof Error ? e.message : e}`);
  }
}

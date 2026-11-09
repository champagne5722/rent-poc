import type { DispatchResult as EmailDispatchResult } from '../notifications';
import { withTx } from '../pg/database';
import type { DispatchResult, InboxResult } from '../signing-module/module';
import { taipeiToday } from './dates';
import { listWorkOrgIds } from './orgs';
import { runScanTimers } from './scan-timers';
import type { TimerRegistry } from './timers/registry';

// 內部 job（ADR-0020 決議 3、7、8）。入口只有 POST /api/internal/jobs/:name，名稱對到這裡的一個函式。
// job 共用 src/lib 的領域程式碼，這裡只負責「找出要做的工作、限量、彙整結果」。
//
// 規則：
// - 一個任務一個交易，一個任務失敗不影響其他任務（認領用 FOR UPDATE SKIP LOCKED，在各自的 store）。
// - 每次最多處理固定筆數，剩下的留給下一次排程。週期是排程設定，不寫在程式碼。
// - 筆數上限必須低於連線池能負擔的量（ADR-0020 Consequences）。job 逐筆循序處理，一次只佔一條連線。

/** drain-inbox 一次處理的筆數。處理一筆只有資料庫操作，量可以大一點。 */
export const DRAIN_INBOX_LIMIT = 100;
/** drain-outbox 一次處理的筆數。每筆要呼叫點點簽，比較慢。 */
export const DRAIN_OUTBOX_LIMIT = 50;
/** scan-timers 一次執行的項目數。當日觸發的提醒漏掉就沒了，所以上限訂寬。 */
export const SCAN_TIMERS_LIMIT = 500;

export interface JobContext {
  /** 現在時間，由呼叫端傳入，job 內不讀時鐘。 */
  now: Date;
}

export type JobResult = Record<string, unknown>;
export type JobHandler = (ctx: JobContext) => Promise<JobResult>;
export type JobTable = Readonly<Record<string, JobHandler>>;

/** job 需要的簽署模組介面。 */
export interface JobSigning {
  drainInbox(limit: number): Promise<InboxResult[]>;
  drainOutbox(orgId: string, limit: number): Promise<DispatchResult[]>;
}

/** job 需要的通知模組介面：重試到期的通知 email（MIL-120）。 */
export interface JobNotifications {
  drainEmails(orgId: string, limit: number): Promise<EmailDispatchResult[]>;
}

export interface JobDeps {
  signing: JobSigning;
  notifications: JobNotifications;
  timers: TimerRegistry;
  limits?: { inbox?: number; outbox?: number; timers?: number };
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function summarizeInbox(results: InboxResult[]) {
  const count = (kind: InboxResult['kind']) => results.filter((r) => r.kind === kind).length;
  const nowDead = results.filter((r) => (r.kind === 'failed' || r.kind === 'deferred') && r.status === 'dead').length;
  return {
    processed: results.length,
    done: count('done'),
    ignored: count('ignored'),
    deferred: count('deferred'),
    failed: count('failed'),
    notClaimed: count('not_claimed'),
    dead: nowDead,
  };
}

export function summarizeOutbox(results: DispatchResult[]) {
  const count = (kind: DispatchResult['kind']) => results.filter((r) => r.kind === kind).length;
  return {
    processed: results.length,
    done: count('done'),
    skipped: count('skipped'),
    failed: count('failed'),
    notClaimed: count('not_claimed'),
    dead: results.filter((r) => r.kind === 'failed' && r.status === 'dead').length,
  };
}

export function summarizeEmails(results: EmailDispatchResult[]) {
  const count = (kind: EmailDispatchResult['kind']) => results.filter((r) => r.kind === kind).length;
  return {
    processed: results.length,
    sent: count('sent'),
    skipped: count('skipped'),
    failed: count('failed'),
    dead: results.filter((r) => r.kind === 'failed' && r.status === 'dead').length,
  };
}

/**
 * 轉人工處理清單的列要讓人看到：每次 job 結果有 dead 的筆數，這裡再記一筆 error log（維運的告警條件）。
 * 清單本身用 listDeadInbox（control）與 listDeadOutbox（逐組織）讀。
 */
function alertDead(job: string, dead: number): void {
  if (dead > 0) console.error(`[jobs] ${job}：${dead} 筆重試用完，已轉人工處理清單`);
}

export function createJobs(deps: JobDeps): JobTable {
  const limits = {
    inbox: deps.limits?.inbox ?? DRAIN_INBOX_LIMIT,
    outbox: deps.limits?.outbox ?? DRAIN_OUTBOX_LIMIT,
    timers: deps.limits?.timers ?? SCAN_TIMERS_LIMIT,
  };

  return {
    // inbox 在 control，不用逐組織：每一列的組織由路由列查出
    async 'drain-inbox'() {
      const results = await deps.signing.drainInbox(limits.inbox);
      const summary = summarizeInbox(results);
      alertDead('drain-inbox', summary.dead);
      return { ...summary, limit: limits.inbox, truncated: results.length >= limits.inbox };
    },

    // outbox 在各組織內：從 control 取得組織清單，逐組織認領。簽署動作與通知 email 各用一份筆數上限，
    // 簽署動作多時不會餓死通知。寄信是至少一次：寄出後寫回失敗時，列會被視為中斷並重寄（MIL-120）
    async 'drain-outbox'() {
      const orgIds = await withTx({ kind: 'control' }, listWorkOrgIds);
      const results: DispatchResult[] = [];
      const emails: EmailDispatchResult[] = [];
      let orgErrors = 0;
      for (const orgId of orgIds) {
        // 一個組織、一種動作出錯不影響其他組織與其他動作
        const signingRemaining = limits.outbox - results.length;
        if (signingRemaining > 0) {
          try {
            results.push(...(await deps.signing.drainOutbox(orgId, signingRemaining)));
          } catch (e) {
            orgErrors++;
            console.error(`[jobs] drain-outbox 組織 ${orgId} 失敗：${errorMessage(e)}`);
          }
        }
        const emailRemaining = limits.outbox - emails.length;
        if (emailRemaining > 0) {
          try {
            emails.push(...(await deps.notifications.drainEmails(orgId, emailRemaining)));
          } catch (e) {
            orgErrors++;
            console.error(`[jobs] drain-outbox 組織 ${orgId} 的通知 email 失敗：${errorMessage(e)}`);
          }
        }
        if (results.length >= limits.outbox && emails.length >= limits.outbox) break;
      }
      const summary = summarizeOutbox(results);
      const emailSummary = summarizeEmails(emails);
      alertDead('drain-outbox', summary.dead);
      alertDead('drain-outbox（通知 email）', emailSummary.dead);
      return {
        ...summary,
        emails: emailSummary,
        orgs: orgIds.length,
        orgErrors,
        limit: limits.outbox,
        truncated: results.length >= limits.outbox || emails.length >= limits.outbox,
      };
    },

    async 'scan-timers'(ctx) {
      return { ...(await runScanTimers(deps.timers, { today: taipeiToday(ctx.now), limit: limits.timers })) };
    },

    // anchor-audit、verify-audit 屬 MIL-88，在那張票加到這裡
  };
}

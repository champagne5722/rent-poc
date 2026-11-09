import { runAnchorAudit } from '../audit/anchor/anchor-audit';
import type { AuditLogger } from '../audit/anchor/audit-log';
import type { AnchorProviders } from '../audit/anchor/providers-from-env';
import { runVerifyAudit } from '../audit/anchor/verify-audit';
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

/** anchor-audit 與 verify-audit 需要的錨定服務（MIL-88）。沒有提供時，這兩個 job 不註冊，呼叫回 404。 */
export interface JobAudit {
  /** 每次 job 執行時才呼叫：設定錯誤只讓這兩個 job 回 500，不影響其他 job。 */
  providers(): AnchorProviders;
  logger?: AuditLogger;
}

export interface JobDeps {
  signing: JobSigning;
  timers: TimerRegistry;
  audit?: JobAudit;
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

/**
 * 轉人工處理清單的列要讓人看到：每次 job 結果有 dead 的筆數，這裡再記一筆 error log（維運的告警條件）。
 * 清單本身用 listDeadInbox（control）與 listDeadOutbox（逐組織）讀。
 */
function alertDead(job: string, dead: number): void {
  if (dead > 0) console.error(`[jobs] ${job}：${dead} 筆重試用完，已轉人工處理清單`);
}

function auditJobs(audit: JobAudit): JobTable {
  return {
    // 結果的 status 是 failed 時仍回 200：失敗已記在資料庫，排程重試會在幾分鐘內再打一次 FreeTSA（每秒限 1 次），
    // 且連續失敗次數會被算快。下一次排程自然重送（ADR-0019 決議 10）
    async 'anchor-audit'(ctx) {
      return { ...(await runAnchorAudit({ withTx, provider: audit.providers().primary, logger: audit.logger }, ctx.now)) };
    },

    // 驗證出問題時也回 200：問題是資料狀態，重試不會改變結果。維運靠 CRITICAL log 告警（見 audit-log.ts）
    async 'verify-audit'(ctx) {
      return { ...(await runVerifyAudit({ withTx, providers: audit.providers().byId, logger: audit.logger }, ctx.now)) };
    },
  };
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

    // outbox 在各組織內：從 control 取得組織清單，逐組織認領。總筆數受 limit 限制
    async 'drain-outbox'() {
      const orgIds = await withTx({ kind: 'control' }, listWorkOrgIds);
      const results: DispatchResult[] = [];
      let orgErrors = 0;
      for (const orgId of orgIds) {
        const remaining = limits.outbox - results.length;
        if (remaining <= 0) break;
        try {
          results.push(...(await deps.signing.drainOutbox(orgId, remaining)));
        } catch (e) {
          // 一個組織出錯不影響其他組織
          orgErrors++;
          console.error(`[jobs] drain-outbox 組織 ${orgId} 失敗：${errorMessage(e)}`);
        }
      }
      const summary = summarizeOutbox(results);
      alertDead('drain-outbox', summary.dead);
      return { ...summary, orgs: orgIds.length, orgErrors, limit: limits.outbox, truncated: results.length >= limits.outbox };
    },

    async 'scan-timers'(ctx) {
      return { ...(await runScanTimers(deps.timers, { today: taipeiToday(ctx.now), limit: limits.timers })) };
    },

    // 稽核鏈的每日錨定與驗證（MIL-88，ADR-0019）。有任何組織寫入的鏈才會錨定，沒有新事件就不呼叫外部服務
    ...(deps.audit && auditJobs(deps.audit)),
  };
}

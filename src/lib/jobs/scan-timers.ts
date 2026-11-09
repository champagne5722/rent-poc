import { withTx } from '../pg/database';
import type { Tx } from '../pg/with-tx';
import { listWorkOrgIds } from './orgs';
import { invalidFireReason, timerIdempotencyKey, type TimerDefinition, type TimerFire, type TimerRegistry } from './timers/registry';

// scan-timers：執行已註冊的計時器（ADR-0020 決議 3、7，MIL-86）。
//
// 每個項目一個交易，失敗不影響其他項目。交易內的順序：
//   1. 寫 control.timer_fires（冪等鍵 = 主體、事件、日期）。鍵已存在就略過，什麼都不做。
//   2. 呼叫計時器的 fire。丟例外時整個交易回滾，包含第 1 步，所以下一次掃描會再試。
// 效果與冪等紀錄同進同出，所以重跑、補跑、兩個排程同時跑，效果都只發生一次。
//
// 一次執行的量有上限（limit）。超過的項目留給下一次執行，result.truncated 為 true。
// 當日觸發的提醒若一天內沒執行完就會漏掉，所以 limit 要訂得比一天的量大，truncated 出現時要補跑。

export interface ScanTimersOptions {
  /** 台灣日期，YYYY-MM-DD。由呼叫端傳入，函式內不讀時鐘。 */
  today: string;
  /** 一次最多執行（含失敗）幾個項目。 */
  limit: number;
}

export interface TimerFailure {
  timer: string;
  /** 冪等鍵。掃描本身失敗或項目格式不合、拿不到鍵時是 null。 */
  key: string | null;
  error: string;
}

export interface ScanTimersResult {
  today: string;
  /** 已註冊的計時器數。 */
  timers: number;
  fired: number;
  /** 冪等鍵已存在而略過的項目。 */
  skipped: number;
  failed: number;
  /** 失敗的明細，最多前 20 筆。 */
  failures: TimerFailure[];
  /** 還有項目因為上限沒有處理。 */
  truncated: boolean;
}

const MAX_FAILURES_LISTED = 20;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runScanTimers(registry: TimerRegistry, options: ScanTimersOptions): Promise<ScanTimersResult> {
  const timers = registry.list();
  const result: ScanTimersResult = {
    today: options.today,
    timers: timers.length,
    fired: 0,
    skipped: 0,
    failed: 0,
    failures: [],
    truncated: false,
  };
  let budget = options.limit;

  const fail = (failure: TimerFailure) => {
    result.failed++;
    if (result.failures.length < MAX_FAILURES_LISTED) result.failures.push(failure);
    console.error(`[timers] ${failure.timer} ${failure.key ?? ''} 失敗：${failure.error}`);
  };

  // 掃描一個範圍（一個組織，或全域），回傳要執行的項目。已有冪等紀錄的不佔額度
  async function candidates(timer: TimerDefinition, orgId: string | null): Promise<TimerFire[] | null> {
    try {
      const scanned = await scanOne(timer, orgId, options.today);
      const seen = new Set<string>();
      const fires: TimerFire[] = [];
      for (const fire of scanned.fires) {
        const invalid = invalidFireReason(fire);
        if (invalid) {
          fail({ timer: timer.name, key: null, error: invalid });
          continue;
        }
        const key = timerIdempotencyKey(fire);
        if (seen.has(key)) continue;
        seen.add(key);
        if (scanned.done.has(key)) result.skipped++;
        else fires.push(fire);
      }
      return fires;
    } catch (e) {
      fail({ timer: timer.name, key: null, error: errorMessage(e) });
      return null;
    }
  }

  async function run(timer: TimerDefinition, orgId: string | null): Promise<void> {
    if (budget <= 0) {
      result.truncated = true;
      return;
    }
    const fires = await candidates(timer, orgId);
    if (!fires) return;
    for (const fire of fires) {
      if (budget <= 0) {
        result.truncated = true;
        return;
      }
      budget--;
      try {
        if ((await fireOne(timer, orgId, fire)) === 'fired') result.fired++;
        else result.skipped++;
      } catch (e) {
        fail({ timer: timer.name, key: timerIdempotencyKey(fire), error: errorMessage(e) });
      }
    }
  }

  const orgIds = timers.some((t) => t.scope === 'org') ? await withTx({ kind: 'control' }, listWorkOrgIds) : [];
  for (const timer of timers) {
    if (timer.scope === 'global') await run(timer, null);
    else for (const orgId of orgIds) await run(timer, orgId);
  }
  return result;
}

/** 掃描一個範圍，順便查出其中已有冪等紀錄的鍵。掃描與查詢在同一個交易。 */
async function scanOne(timer: TimerDefinition, orgId: string | null, today: string) {
  const read = async (tx: Tx, scan: () => Promise<TimerFire[]>) => {
    const fires = await scan();
    const keys = [...new Set(fires.map((f) => timerIdempotencyKey(f)))];
    const { rows } = keys.length
      ? await tx.query<{ idempotency_key: string }>(
          'SELECT idempotency_key FROM control.timer_fires WHERE idempotency_key = ANY($1::text[])',
          [keys],
        )
      : { rows: [] };
    return { fires, done: new Set(rows.map((r) => r.idempotency_key)) };
  };
  if (timer.scope === 'global') {
    return withTx({ kind: 'control' }, (tx) => read(tx, () => timer.scan(tx, today)));
  }
  return withTx({ kind: 'org', orgId: orgId! }, (tx) => read(tx, () => timer.scan(tx, today)));
}

async function fireOne(timer: TimerDefinition, orgId: string | null, fire: TimerFire): Promise<'fired' | 'skipped'> {
  const claim = async (tx: Tx): Promise<boolean> => {
    const { rows } = await tx.query<{ idempotency_key: string }>(
      `INSERT INTO control.timer_fires (idempotency_key, timer, subject_id, event, fire_date, org_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [timerIdempotencyKey(fire), timer.name, fire.subjectId, fire.event, fire.date, orgId],
    );
    return rows.length === 1;
  };
  if (timer.scope === 'global') {
    return withTx({ kind: 'control' }, async (tx) => {
      if (!(await claim(tx))) return 'skipped';
      await timer.fire(tx, fire);
      return 'fired';
    });
  }
  return withTx({ kind: 'org', orgId: orgId! }, async (tx) => {
    if (!(await claim(tx))) return 'skipped';
    await timer.fire(tx, fire);
    return 'fired';
  });
}

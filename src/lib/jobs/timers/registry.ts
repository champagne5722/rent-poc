import type { ControlTx, OrgTx } from '../../pg/with-tx';

// 計時器的註冊機制（ADR-0020 決議 3、7，ADR-0016 決議 18）。
//
// A 線只交註冊與執行機制，計時器本身由各線註冊：
//   C 線 MIL-112：委託到期、換證窗口、證書期滿、任職重驗、執業主體重查、證據檔刪除
//   E 線 MIL-129、130、136；F 線 MIL-107
// 註冊的方式見 ./index.ts。執行見 ../scan-timers.ts。
//
// 一個計時器分兩步，都在 scan-timers 的控制之下：
//   scan：讀事實，回傳「今天哪些主體該做什麼事」。純讀取，不得有副作用。C 線的純函式（registry-rules/timers.ts）
//         的決策可以直接轉成 TimerFire。
//   fire：執行一個項目的效果（改狀態、寫通知、刪檔排程）。scan-timers 先在同一個交易寫冪等紀錄，
//         寫入成功才呼叫它。它丟例外時整個交易回滾，冪等紀錄也不留，下一次掃描會再試。
//         fire 內不得有外部 API 呼叫（ADR-0012 決議 10）。寄信等外部動作寫成 outbox 列，提交後派送。

/** 一個要執行的項目。冪等鍵 = 主體、事件、日期。 */
export interface TimerFire {
  /** 主體的 ID（ULID 等），不得含冒號。 */
  subjectId: string;
  /** 事件名稱，小寫英數與底線，例如 mandate_expired。 */
  event: string;
  /**
   * 冪等鍵用的日期。當日觸發的提醒是當日（YYYY-MM-DD）。
   * 狀態驅動的計時器用條件首次成立的那一天，補跑多日仍是同一把鍵。每月重查用年月（YYYY-MM）。
   */
  date: string;
}

interface TimerBase {
  /** 計時器名稱，全系統唯一，小寫英數與底線。 */
  name: string;
}

/** 資料在組織內的計時器（org schema）。scan-timers 逐組織開組織交易，所以 scan 與 fire 只看得到該組織的資料。 */
export interface OrgTimer extends TimerBase {
  scope: 'org';
  /** today 是台灣日期（YYYY-MM-DD）。 */
  scan(tx: OrgTx, today: string): Promise<TimerFire[]>;
  fire(tx: OrgTx, fire: TimerFire): Promise<void>;
}

/** 資料不屬於任何組織的計時器（registry 的執業主體、證書、任職）。用 control 脈絡。 */
export interface GlobalTimer extends TimerBase {
  scope: 'global';
  scan(tx: ControlTx, today: string): Promise<TimerFire[]>;
  fire(tx: ControlTx, fire: TimerFire): Promise<void>;
}

export type TimerDefinition = OrgTimer | GlobalTimer;

export interface TimerRegistry {
  register(timer: TimerDefinition): void;
  /** 依名稱排序，執行順序固定。 */
  list(): readonly TimerDefinition[];
}

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const EVENT_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DATE_PATTERN = /^\d{4}-\d{2}(-\d{2})?$/;

export function timerIdempotencyKey(fire: TimerFire): string {
  return `${fire.subjectId}:${fire.event}:${fire.date}`;
}

/** 掃出來的項目格式不合時回傳原因，合格回 null。一筆壞資料不得中斷整輪。 */
export function invalidFireReason(fire: TimerFire): string | null {
  if (typeof fire?.subjectId !== 'string' || !SUBJECT_PATTERN.test(fire.subjectId)) {
    return `主體 ID 格式不合：${String(fire?.subjectId)}`;
  }
  if (typeof fire.event !== 'string' || !EVENT_PATTERN.test(fire.event)) return `事件名稱格式不合：${String(fire.event)}`;
  if (typeof fire.date !== 'string' || !DATE_PATTERN.test(fire.date)) return `日期格式不合：${String(fire.date)}`;
  return null;
}

export function createTimerRegistry(): TimerRegistry {
  const timers = new Map<string, TimerDefinition>();
  return {
    register(timer) {
      if (!NAME_PATTERN.test(timer.name)) throw new Error(`計時器名稱只允許小寫英數與底線：${timer.name}`);
      if ((timer.scope as string) !== 'org' && (timer.scope as string) !== 'global') {
        throw new Error(`計時器 ${timer.name} 的 scope 必須是 org 或 global`);
      }
      if (timers.has(timer.name)) throw new Error(`計時器 ${timer.name} 已註冊`);
      timers.set(timer.name, timer);
    },
    list: () => [...timers.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

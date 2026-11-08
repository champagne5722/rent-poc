import { AsyncLocalStorage } from 'node:async_hooks';
import type { SqlExecutor, TxDriver } from './executor';
import { isUlid } from './ulid';
import { recordOperatorAccess } from '../audit/operator-access';

// withTx：取得資料庫的唯一入口（ADR-0012 決議 10，MIL-80）。
//
// 規則（介面的一部分，呼叫端必須知道）：
// 1. 每次呼叫是一個交易。組織脈絡只用交易範圍的 set_config(..., true)，結束即消失，
//    不用 session 層級的 SET，連線池重用時前一個請求的組織不會外洩。
// 2. callback 內不得有外部 API 呼叫、fs 非同步操作與計時器。交易佔著連線，
//    這類呼叫一慢，連線池就被耗盡；停在交易內太久會被 idle_in_transaction_session_timeout 終止。
//    外部呼叫改寫 outbox，提交後再派送（ADR-0020）。ESLint 只擋直接寫在 callback 裡的 fetch、fs、計時器
//    （eslint.config.mjs）。經由別的函式間接呼叫抓不到，靠 review。
// 3. callback 拋出任何例外，整個交易回滾，原本的例外原樣丟出。
// 4. 不得巢狀呼叫。巢狀會再借一條連線（PGlite 則直接死結），而且兩個交易的脈絡互相看不見。
// 5. tx 只在 callback 執行期間有效，callback 結束後再用會丟錯。

// ---------------------------------------------------------------------------
// 脈絡

export type ContextKind = 'org' | 'party' | 'control' | 'operator';

/** 一般請求、逐組織的 job。設定 app.org_id，有 partyId 時再設 app.party_id。 */
export interface OrgContext {
  kind: 'org';
  orgId: string;
  partyId?: string;
}

/** 沒有組織的案件成員讀取（承租人）。只設定 app.party_id。 */
export interface PartyContext {
  kind: 'party';
  partyId: string;
}

/** 登入、webhook 查路由、取任務。不設定任何脈絡，組織表一律回傳 0 筆。 */
export interface ControlContext {
  kind: 'control';
}

/**
 * 平台營運者存取某個組織的資料。必須帶工單號。
 * 設定 app.org_id（目標組織）、app.operator_id、app.ticket_id。
 * 開完交易後、執行 callback 之前，withTx 在同一個交易寫存取紀錄（audit.record_operator_access()，
 * 讀的就是這三個設定，MIL-82）。紀錄寫不進去時交易失敗，callback 不會執行。
 */
export interface OperatorContext {
  kind: 'operator';
  operatorId: string;
  orgId: string;
  ticketId: string;
}

export type DbContext = OrgContext | PartyContext | ControlContext | OperatorContext;

// ---------------------------------------------------------------------------
// tx 的型別標記

/**
 * 交易代理。K 標記它是哪一種脈絡開出來的，repository 方法用參數型別限定範圍：
 *   function listObjects(tx: OrgTx)       // org 與 operator 都可以傳
 *   function claimTask(tx: ControlTx)     // 傳 org 的 tx 會讓 tsc 報錯
 */
export interface Tx<K extends ContextKind = ContextKind> {
  readonly kind: K;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** 組織範圍：org 脈絡，或平台營運者進入某個組織。 */
export type OrgTx = Tx<'org' | 'operator'>;
export type PartyTx = Tx<'party'>;
export type ControlTx = Tx<'control'>;

// ---------------------------------------------------------------------------
// 開交易的語句

export interface TxOptions {
  /** 單一語句上限，毫秒。 */
  statementTimeoutMs?: number;
  /** 交易開著卻沒有語句的上限，毫秒。 */
  idleInTransactionTimeoutMs?: number;
  /**
   * 開完交易（BEGIN 與脈絡設定都已送出）後、執行 callback 之前的 hook，與 callback 同一個交易。
   * 拋出例外時整個交易回滾，callback 不會執行。
   * operator 脈絡的存取紀錄（MIL-82）一定先寫，這個 hook 在它之後執行，不能取代或跳過它。
   */
  afterBegin?: (ctx: DbContext, conn: SqlExecutor) => Promise<void>;
}

export const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 10_000;

// 工單號由平台營運者的審核台產生。格式沒有定案，這裡只收字母數字開頭、64 字內的安全字元
const TICKET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:#-]{0,63}$/;

function requireUlid(value: unknown, field: string): string {
  if (!isUlid(value)) throw new Error(`withTx 脈絡的 ${field} 不是合法的 ULID`);
  return value;
}

function requireTicket(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('operator 脈絡必須帶工單號，不得為空');
  if (!TICKET_PATTERN.test(value)) throw new Error('operator 脈絡的工單號格式不符（字母數字開頭，64 字內）');
  return value;
}

/** 脈絡對應的 set_config 設定。每個值都先通過格式檢查，才會被組進 SQL。 */
function settingsOf(ctx: DbContext): Array<[name: string, value: string]> {
  switch (ctx.kind) {
    case 'org': {
      const s: Array<[string, string]> = [['app.org_id', requireUlid(ctx.orgId, 'orgId')]];
      if (ctx.partyId !== undefined) s.push(['app.party_id', requireUlid(ctx.partyId, 'partyId')]);
      return s;
    }
    case 'party':
      return [['app.party_id', requireUlid(ctx.partyId, 'partyId')]];
    case 'control':
      return [];
    case 'operator':
      return [
        ['app.org_id', requireUlid(ctx.orgId, 'orgId')],
        ['app.operator_id', requireUlid(ctx.operatorId, 'operatorId')],
        ['app.ticket_id', requireTicket(ctx.ticketId)],
      ];
    default:
      throw new Error(`withTx 不認得的脈絡種類：${String((ctx as { kind?: unknown }).kind)}`);
  }
}

function timeoutMs(value: number | undefined, fallback: number): number {
  const ms = value ?? fallback;
  if (!Number.isInteger(ms) || ms < 0) throw new Error('逾時設定必須是非負整數毫秒');
  return ms;
}

/**
 * BEGIN、逾時設定與 set_config 併成一段，由 exec 一次送出，只有一次往返。
 * 值已通過格式檢查（ULID 或工單號），不含引號與反斜線，所以可以直接當字面值組進語句。
 * 組語句的位置只有這裡。
 */
export function buildBeginSql(ctx: DbContext, options: TxOptions = {}): string {
  const settings = settingsOf(ctx);
  const statements = [
    'BEGIN',
    `SET LOCAL statement_timeout = ${timeoutMs(options.statementTimeoutMs, DEFAULT_STATEMENT_TIMEOUT_MS)}`,
    `SET LOCAL idle_in_transaction_session_timeout = ${timeoutMs(options.idleInTransactionTimeoutMs, DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS)}`,
  ];
  if (settings.length > 0) {
    statements.push(`SELECT ${settings.map(([name, value]) => `set_config('${name}', '${value}', true)`).join(', ')}`);
  }
  return statements.join(';\n');
}

// ---------------------------------------------------------------------------
// 執行

/** 平台營運者存取組織資料時，同交易留下紀錄（P0-23 AC5）。不可關閉，之後才執行呼叫端的 afterBegin。 */
async function beginHook(ctx: DbContext, conn: SqlExecutor, extra: TxOptions['afterBegin']): Promise<void> {
  if (ctx.kind === 'operator') await recordOperatorAccess(conn);
  await extra?.(ctx, conn);
}

const insideTx = new AsyncLocalStorage<true>();

type AfterBegin = (ctx: DbContext, conn: SqlExecutor) => Promise<void>;

export type WithTx = <C extends DbContext, R>(ctx: C, fn: (tx: Tx<C['kind']>) => Promise<R>) => Promise<R>;

/** 綁定一個驅動的 withTx。應用程式用 database.ts 匯出的預設版本，測試用這個注入 PGlite。 */
export function createWithTx(driver: TxDriver, options: TxOptions = {}): WithTx {
  return async (ctx, fn) => {
    if (insideTx.getStore()) throw new Error('withTx 不得巢狀呼叫：交易內要用外層給的 tx');
    // 先驗證再借連線：格式錯誤的請求不佔連線池
    const beginSql = buildBeginSql(ctx, options);
    const afterBegin: AfterBegin = (c, conn) => beginHook(c, conn, options.afterBegin);

    const lease = await driver.acquire();
    let broken = false;
    try {
      return await insideTx.run(true, () => runInTransaction(lease.conn, ctx, beginSql, afterBegin, fn));
    } catch (error) {
      try {
        await lease.conn.exec('ROLLBACK');
      } catch {
        broken = true; // 連線狀態不明，不得放回連線池
      }
      throw error;
    } finally {
      lease.release(broken);
    }
  };
}

async function runInTransaction<C extends DbContext, R>(
  conn: SqlExecutor,
  ctx: C,
  beginSql: string,
  afterBegin: AfterBegin,
  fn: (tx: Tx<C['kind']>) => Promise<R>,
): Promise<R> {
  await conn.exec(beginSql);
  await afterBegin(ctx, conn);
  let open = true;
  const tx: Tx<C['kind']> = {
    kind: ctx.kind,
    query: (sql, params) => {
      if (!open) return Promise.reject(new Error('tx 已結束：callback 回傳後不得再使用'));
      return conn.query(sql, params);
    },
  };
  let result: R;
  try {
    result = await fn(tx);
  } finally {
    open = false;
  }
  await conn.exec('COMMIT');
  return result;
}

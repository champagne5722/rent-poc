// 別名：useXxx 的名字會被 react-hooks/rules-of-hooks 當成 Hook
import { useTxDriver as installTxDriver } from './database';
import { pgliteDriver } from './drivers';
import { asRole, createTestDb, type TestDb } from './test-harness';
import { newUlid } from './ulid';
import { TRANSITIONAL_PARTY_ID, TRANSITIONAL_USER_ID, type RequestContext } from '../request-context';

// route 層測試的共用工具（MIL-81 定下，之後各實體的 route 測試照用）。
//
// 用法（vi.mock 會被提升到檔案頂端，所以要用動態 import 取得 stub）：
//   vi.mock('@/lib/current-request-context', async () => ({
//     requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
//   }));
//   const kit = await setupRouteDb();   // beforeAll
//   await kit.reset();                  // beforeEach：換一個新的 app_rw 資料庫，重建 orgA、orgB
//   actAs(kit.orgA);                    // 之後 route 看到的請求脈絡是 orgA 的管理員
//
// 連線身分一律是 app_rw（test-harness 的 fresh()），RLS 才會生效。

const state: { current: RequestContext | Error | null } = { current: null };

/** 取代 requestContext()。沒有 actAs 時丟錯，避免測試意外用到上一個測試的身分。 */
export async function stubRequestContext(): Promise<RequestContext> {
  const current = state.current;
  if (current === null) throw new Error('測試沒有呼叫 actAs() 或 actAsError()');
  if (current instanceof Error) throw current;
  return current;
}

export function actAs(orgId: string): void {
  state.current = {
    kind: 'org',
    orgId,
    orgKind: 'owner',
    userId: TRANSITIONAL_USER_ID,
    partyId: TRANSITIONAL_PARTY_ID,
    role: 'admin',
    requestId: 'test',
  };
}

/** 讓 requestContext() 丟指定的錯，例如 new Unauthenticated()。 */
export function actAsError(error: Error): void {
  state.current = error;
}

export interface RouteDb {
  testDb: TestDb;
  orgA: string;
  orgB: string;
  /** 換成全新的 app_rw 資料庫（只有 migration 與種子），重建兩個組織。 */
  reset(): Promise<void>;
  /** 用 app_owner 身分執行，只給測試觀察 registry 這類 app_rw 看不到的表。 */
  asOwner<T>(fn: (db: import('@electric-sql/pglite').PGliteInterface) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function setupRouteDb(): Promise<RouteDb> {
  const testDb = await createTestDb();
  let db: import('@electric-sql/pglite').PGliteInterface | undefined;
  const kit: RouteDb = {
    testDb,
    orgA: newUlid(),
    orgB: newUlid(),
    async reset() {
      await db?.close();
      db = await testDb.fresh();
      installTxDriver(pgliteDriver(db));
      await asRole(db, 'app_owner', () =>
        db!.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A 組織', 'owner'), ($2, 'B 組織', 'owner')`, [
          kit.orgA,
          kit.orgB,
        ]),
      );
      state.current = null;
    },
    asOwner: (fn) => asRole(db!, 'app_owner', () => fn(db!)),
    async close() {
      installTxDriver(undefined);
      await db?.close();
      await testDb.close();
    },
  };
  return kit;
}

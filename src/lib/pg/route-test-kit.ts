// 別名：useXxx 的名字會被 react-hooks/rules-of-hooks 當成 Hook
import { useTxDriver as installTxDriver } from './database';
import { pgliteDriver } from './drivers';
import { asRole, createTestDb, type TestDb } from './test-harness';
import { newUlid } from './ulid';
import type { RequestContext } from '../request-context';

// 測試用的固定使用者與 party（時間部分全 0，不會和真實 ULID 撞號）
export const TEST_USER_ID = '00000000000000000000000003';
export const TEST_PARTY_ID = '00000000000000000000000004';

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

let anchorKeySeq = 0;

/**
 * 登錄新物件必須填建號（ADR-0028 決議 9）。route 測試用它補上 anchor.key。
 * 每次回傳不同的建號：同一個組織用同一個鍵登錄第二次，會得到自己既有的那一筆，而不是新物件。
 * 縣市與段是固定的真實資料（臺北市大安區 龍泉 一）。
 */
export function nextAnchorKey(): { city: string; town: string; section: string; buildingNo: string; subNo: string } {
  anchorKeySeq += 1;
  return { city: 'A', town: '02', section: '0021', buildingNo: String(10000 + anchorKeySeq), subNo: '' };
}

export function actAs(orgId: string): void {
  state.current = {
    kind: 'org',
    orgId,
    orgKind: 'owner',
    userId: TEST_USER_ID,
    partyId: TEST_PARTY_ID,
    role: 'admin',
    requestId: 'test',
  };
}

/** 目前 actAs 的組織 ID。不是組織身分（或沒有 actAs）時回 null。測試的資料準備用它決定物件屬於哪個組織。 */
export function actingOrgId(): string | null {
  const current = state.current;
  return current !== null && !(current instanceof Error) && current.kind === 'org' ? current.orgId : null;
}

/** 登入了但不是組織身分（承租人），route 必須回 403。 */
export function actAsParty(): void {
  state.current = { kind: 'party', userId: newUlid(), partyId: newUlid(), requestId: 'test' };
}

/** 讓 requestContext() 回傳指定的完整脈絡，例如經理人、承租人或營運者。 */
export function actAsContext(rc: RequestContext): void {
  state.current = rc;
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
      // actAs() 的使用者對應的 party。案件成員（MIL-115）的 party_id 有外鍵指向 control.parties，
      // 建約會把建立者加為出租人成員，所以這個 party 必須存在
      await asRole(db, 'app_owner', () =>
        db!.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'route-test@example.com', '路由測試帳號')`, [
          TEST_PARTY_ID,
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

import { authorize, bindAccessContext, Forbidden } from '../authorize';
import { requestContext } from '../current-request-context';
import { getFileStore } from '../file-store';
import { withTx } from '../pg/database';
import { isUlid } from '../pg/ulid';
import { getMyRegistration } from '../practice-entities/applicant';
import { listPropertyGroups } from '../properties';
import { listOrgEmployments } from '../practitioners/applicant';
import { toDbContext, Unauthenticated } from '../request-context';
import type {
  MandateManagerCandidate,
  MandateRequestKind,
  MandateRequestLinkView,
  OwnerMandateRequest,
  PracticeMandateRequest,
  PropertyGroup,
} from '../types';
import { isWellFormedRequestCode } from './code';
import { deleteTranscriptFiles } from './files';
import { listManagerCandidates } from './decision-repository';
import { getOwnerRequest, listOwnerRequests } from './owner-repository';
import { expireMandateRequests, getLinkView, getPracticeRequest, listPracticeRequests } from './repository';
import { requestKindsFor } from './view';

// 申請畫面的資料載入（MIL-206 畫面段）。頁面在 server component 呼叫它，client component 只管互動。
// 讀的資料與 route 相同（GET /api/mandate-requests、GET /api/mandate-requests/[id]），權限檢查也相同（request.read）。
// 沒登入時丟 Unauthenticated，由頁面導向登入。只給 server component 用；route handler 走 inOrgTxAs。
// 這個檔案沒有任何寫入屋主資料的動作。業者讀列表時順手清掉失效申請，與 GET /api/mandate-requests 相同。

export type RequestListLoad =
  | { kind: 'practice'; requests: PracticeMandateRequest[]; creatableKinds: MandateRequestKind[] }
  | { kind: 'owner'; requests: OwnerMandateRequest[] }
  // 不是業者或屋主的組織，或身分沒有查看申請的權限
  | { kind: 'forbidden' };

export async function loadRequestList(): Promise<RequestListLoad> {
  const rc = await requestContext();
  if (rc.kind !== 'org' || (rc.orgKind !== 'practice' && rc.orgKind !== 'owner')) return { kind: 'forbidden' };
  const now = new Date();
  let expiredKeys: string[] = [];
  try {
    const result = await withTx(toDbContext(rc), async (tx): Promise<RequestListLoad> => {
      bindAccessContext(tx, rc);
      await authorize(tx, 'request.read', { type: 'org' });
      if (rc.orgKind === 'owner') return { kind: 'owner', requests: await listOwnerRequests(tx, now) };
      expiredKeys = await expireMandateRequests(tx, now);
      const registration = await getMyRegistration(tx);
      const verified = (registration?.licenses ?? []).filter((l) => l.state === 'verified').map((l) => l.kind);
      return { kind: 'practice', requests: await listPracticeRequests(tx, now), creatableKinds: requestKindsFor(verified) };
    });
    await deleteTranscriptFiles(getFileStore('general'), expiredKeys);
    return result;
  } catch (error) {
    if (error instanceof Forbidden) return { kind: 'forbidden' };
    throw error;
  }
}

export type CreatableKindsLoad = { kind: 'ok'; creatableKinds: MandateRequestKind[] } | { kind: 'forbidden' };

/** 產生連結頁用：目前業者組織已驗證的業別能產生哪些種類。只有業者組織能產生。 */
export async function loadCreatableKinds(): Promise<CreatableKindsLoad> {
  const rc = await requestContext();
  if (rc.kind !== 'org' || rc.orgKind !== 'practice') return { kind: 'forbidden' };
  try {
    return await withTx(toDbContext(rc), async (tx): Promise<CreatableKindsLoad> => {
      bindAccessContext(tx, rc);
      await authorize(tx, 'request.create', { type: 'org' });
      const registration = await getMyRegistration(tx);
      const verified = (registration?.licenses ?? []).filter((l) => l.state === 'verified').map((l) => l.kind);
      return { kind: 'ok', creatableKinds: requestKindsFor(verified) };
    });
  } catch (error) {
    if (error instanceof Forbidden) return { kind: 'forbidden' };
    throw error;
  }
}

export type RequestDetailLoad =
  | {
      kind: 'practice';
      request: PracticeMandateRequest;
      /** 目前身分是組織管理員：只有管理員能接受、不接受與結束。其他角色畫面只顯示說明。 */
      isAdmin: boolean;
      /** 接受時能指派的管理人員。只有管理員、而且申請待業者接受時才讀，否則是空陣列。 */
      candidates: MandateManagerCandidate[];
      /** 已接受的申請指派的管理人員姓名。沒有或任職已不在清單時是 null。 */
      managerName: string | null;
    }
  | {
      kind: 'owner';
      request: OwnerMandateRequest;
      groups: PropertyGroup[];
      /** 屋主端結束申請限 admin 與 staff（動作 request.end）。 */
      canEnd: boolean;
    }
  // 不是自己的申請、不存在、或 ID 格式不合：回應相同，畫面顯示同一個「找不到」
  | { kind: 'not_found' }
  | { kind: 'forbidden' };

export async function loadRequestDetail(id: string): Promise<RequestDetailLoad> {
  const rc = await requestContext();
  if (rc.kind !== 'org' || (rc.orgKind !== 'practice' && rc.orgKind !== 'owner')) return { kind: 'forbidden' };
  if (!isUlid(id)) return { kind: 'not_found' };
  const now = new Date();
  try {
    return await withTx(toDbContext(rc), async (tx): Promise<RequestDetailLoad> => {
      bindAccessContext(tx, rc);
      await authorize(tx, 'request.read', { type: 'org' });
      if (rc.orgKind === 'owner') {
        const request = await getOwnerRequest(tx, id, now);
        if (!request) return { kind: 'not_found' };
        // 租賃單位的選單：屋主自己登錄的。要有物件讀取權限，沒有時當作沒有物件
        let groups: PropertyGroup[] = [];
        try {
          await authorize(tx, 'property.read', { type: 'org' });
          groups = await listPropertyGroups(tx);
        } catch (error) {
          if (!(error instanceof Forbidden)) throw error;
        }
        return { kind: 'owner', request, groups, canEnd: rc.role !== 'viewer' };
      }
      const request = await getPracticeRequest(tx, id, now);
      if (!request) return { kind: 'not_found' };
      const isAdmin = rc.role === 'admin';
      let candidates: MandateManagerCandidate[] = [];
      if (isAdmin && request.status === 'pending_practice') {
        await authorize(tx, 'request.manager_candidates', { type: 'org' });
        candidates = await listManagerCandidates(tx, now);
      }
      let managerName: string | null = null;
      if (request.manager_employment_id) {
        const employments = await listOrgEmployments(tx);
        managerName = employments.find((employment) => employment.id === request.manager_employment_id)?.displayName ?? null;
      }
      return { kind: 'practice', request, isAdmin, candidates, managerName };
    });
  } catch (error) {
    if (error instanceof Forbidden) return { kind: 'forbidden' };
    throw error;
  }
}

/**
 * 連結頁（登入前就能開）的狀態：
 * - invalid：所有無效的原因都是這一種，畫面完全相同。
 * - anonymous：還沒登入。
 * - no_identity：登入了但帳號還沒有任何身分，畫面請他填屋主名稱。
 * - owner：屋主組織，畫面自動綁定。
 * - not_owner：業者、平台或其他類型的身分。連結頁的資料與登入前相同，另外說明要改用屋主帳號。
 * 連結頁只帶業者的名稱、統編、已驗證的業別與申請的種類，不帶任何物件資料。
 */
export type LinkPageLoad =
  | { kind: 'invalid' }
  | { kind: 'anonymous' | 'no_identity' | 'owner' | 'not_owner'; view: MandateRequestLinkView };

export async function loadLinkPage(code: string): Promise<LinkPageLoad> {
  if (!isWellFormedRequestCode(code)) return { kind: 'invalid' };
  const now = new Date();
  let kind: 'anonymous' | 'no_identity' | 'owner' | 'not_owner' = 'anonymous';
  let ctx: Parameters<typeof withTx>[0] = { kind: 'control' };
  try {
    const rc = await requestContext();
    if (rc.kind === 'org' && rc.orgKind === 'owner') {
      kind = 'owner';
      ctx = toDbContext(rc);
    } else {
      // 業者與平台的組織當作登入前處理（與 GET /api/mandate-requests/link/[code] 相同），看不出綁定與否
      kind = 'not_owner';
      if (rc.kind === 'org') ctx = { kind: 'control' };
    }
  } catch (error) {
    if (!(error instanceof Unauthenticated)) throw error;
    if (error.reason === 'no_identity') kind = 'no_identity';
  }
  const view = await withTx(ctx, (tx) => getLinkView(tx, code, now));
  return view ? { kind, view } : { kind: 'invalid' };
}

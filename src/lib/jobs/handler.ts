import { jsonError, jsonOk } from '../http';
import type { JobTable } from './jobs';
import { bearerToken, verifyOidcToken, type OidcConfig, type OidcDeps } from './oidc';

// POST /api/internal/jobs/:name 的處理（ADR-0020 決議 1、2）。
// 這個路徑不經過 Basic Auth（src/lib/demo-access.ts 的放行清單），所以呼叫者驗證全在這裡：
// Google 簽發的 OIDC token，驗簽章、aud、service account。驗證失敗回 401，不得執行 job。

export interface JobRouteDeps {
  /** 驗證設定。環境變數沒設定時是 null，route 回 503，不執行 job。 */
  config: OidcConfig | null;
  keys: OidcDeps['keys'];
  jobs: JobTable;
  now?: () => Date;
}

const UNAUTHORIZED = '未授權';

export async function handleJobRequest(request: Request, name: string, deps: JobRouteDeps): Promise<Response> {
  // 比照 demo-access 的 misconfigured：沒有設定時拒絕，不得變成不設防
  if (!deps.config) {
    console.error('[jobs] 沒有設定 JOBS_OIDC_AUDIENCE 或 JOBS_OIDC_SERVICE_ACCOUNT，已拒絕內部 job 請求');
    return jsonError(503, '內部 job 尚未設定呼叫者驗證');
  }

  const token = bearerToken(request.headers.get('authorization'));
  if (!token) return jsonError(401, UNAUTHORIZED);
  const verdict = await verifyOidcToken(token, deps.config, { keys: deps.keys, now: deps.now ? () => deps.now!().getTime() : undefined });
  if (!verdict.ok) {
    if (verdict.reason === 'keys_unavailable') {
      // 取不到 Google 的金鑰不是呼叫者的錯。回 503 讓 Cloud Scheduler 依重試設定再試
      console.error('[jobs] 取不到 Google 的 OIDC 公開金鑰');
      return jsonError(503, '暫時無法驗證呼叫者');
    }
    console.warn(`[jobs] 內部 job 呼叫被拒絕：${verdict.reason}`);
    return jsonError(401, UNAUTHORIZED);
  }

  // 驗證通過之後才看 job 名稱。Object.hasOwn 擋掉 constructor、__proto__ 之類的名稱
  if (!Object.hasOwn(deps.jobs, name)) return jsonError(404, '找不到這個 job');
  try {
    const result = await deps.jobs[name]({ now: deps.now?.() ?? new Date() });
    return jsonOk({ job: name, result });
  } catch (e) {
    console.error(`[jobs] ${name} 執行失敗：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return jsonError(500, 'job 執行失敗');
  }
}

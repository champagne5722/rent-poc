import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { jsonError, jsonOk } from '@/lib/http';
import { acceptMandateRequest } from '@/lib/mandate-requests/decision-repository';
import {
  ACCEPT_LICENSE_NOT_VERIFIED_MESSAGE,
  MANAGER_NOT_ELIGIBLE_MESSAGE,
  MANAGER_REQUIRED_MESSAGE,
  NOT_PENDING_PRACTICE_MESSAGE,
  NOT_PRACTICE_ORG_MESSAGE,
  NO_ELIGIBLE_MANAGER_MESSAGE,
  REQUEST_NOT_FOUND_MESSAGE,
} from '@/lib/mandate-requests/messages';
import { getPracticeRequest } from '@/lib/mandate-requests/repository';
import { inOrgTxAs, readJson } from '@/lib/org-route';
import { isUlid } from '@/lib/pg/ulid';

type Ctx = { params: Promise<{ id: string }> };

/**
 * 業者接受申請。只有業者組織的 admin 能呼叫（動作表 request.accept，資料庫函式再查一次）。
 * body：{ manager_employment_id: string }，指派的租賃住宅管理人員的任職 ID，從 GET /api/mandate-requests/manager-candidates 選。
 * 200 回 PracticeMandateRequest，狀態是 accepted，manager_employment_id 是指派的人。同交易對屋主寫一則站內通知，
 * 只寫申請種類與租賃單位數量。
 * 錯誤：404 申請不是這個組織的（含不存在）。
 * 400 沒有帶 manager_employment_id，或指派的人不是自己組織的、現在有效的租賃住宅管理人員（code manager_not_eligible，
 * 別家的任職 ID 與不存在的 ID 回應相同）。
 * 409 組織沒有任何合格的管理人員（code no_eligible_manager，畫面停用接受鍵並提示先完成人員驗證）。
 * 409 申請不是待業者接受，或已失效（code not_pending，兩者回應相同）。
 * 409 申請對應的業別已不是通過驗證的狀態（code license_not_verified）。
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return jsonError(404, REQUEST_NOT_FOUND_MESSAGE);
  const body = (await readJson(request)) as Record<string, unknown> | undefined;
  const managerId = body?.manager_employment_id;
  const now = new Date();
  return inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'request.accept', { type: 'org' });
    if (rc.orgKind !== 'practice') return jsonError(403, NOT_PRACTICE_ORG_MESSAGE);
    if (typeof managerId !== 'string' || !isUlid(managerId)) {
      return jsonError(400, MANAGER_REQUIRED_MESSAGE, { extra: { field: 'manager_employment_id' } });
    }
    switch (await acceptMandateRequest(tx, id, managerId, now)) {
      case 'accepted':
        return jsonOk({ data: await getPracticeRequest(tx, id, now) });
      case 'not_found':
        return jsonError(404, REQUEST_NOT_FOUND_MESSAGE);
      case 'not_pending':
        return jsonError(409, NOT_PENDING_PRACTICE_MESSAGE, 'not_pending');
      case 'no_eligible_manager':
        return jsonError(409, NO_ELIGIBLE_MANAGER_MESSAGE, 'no_eligible_manager');
      case 'manager_not_eligible':
        return jsonError(400, MANAGER_NOT_ELIGIBLE_MESSAGE, { extra: { code: 'manager_not_eligible', field: 'manager_employment_id' } });
      case 'license_not_verified':
        return jsonError(409, ACCEPT_LICENSE_NOT_VERIFIED_MESSAGE, 'license_not_verified');
    }
  });
}

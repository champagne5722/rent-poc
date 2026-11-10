import { authorize, bindAccessContext, checkAccess, Forbidden } from './authorize';
import {
  getCase,
  getOrgName,
  listCaseEvents,
  listCaseMembers,
  listContractsOfCase,
  type CaseContractRow,
  type CaseEventRecord,
  type CaseMemberRecord,
  type CaseRecord,
} from './case-store';
import { requestContext } from './current-request-context';
import { withTx } from './pg/database';
import { isUlid } from './pg/ulid';
import { toDbContext } from './request-context';

// 案件詳情的資料載入（MIL-184）。詳情頁在 server component 呼叫它，GET /api/cases/[id] 的內容相同。
// 主辦組織成員與案件成員都讀得到；成員、合約與事件各依關係過濾（RLS），讀不到的區段是空的。
// 格式錯誤的 ID、別的組織的 ID、不存在的 ID、不是成員，對外同一個畫面（P0-02 AC1）。

export interface CaseDetailData {
  /** 預設收款帳戶 ID 已移除，連到的包租案件 ID 只給主辦組織。 */
  case: Omit<CaseRecord, 'defaultRentAccountId' | 'defaultDepositAccountId' | 'linkedMasterLeaseCaseId'> & {
    linkedMasterLeaseCaseId?: string | null;
  };
  orgName: string | null;
  isHost: boolean;
  members: CaseMemberRecord[];
  contracts: CaseContractRow[];
  events: CaseEventRecord[];
  /** 畫面用它決定要不要顯示「加入共同承租人」。真正的檢查在寫入的 route。 */
  canManageMembers: boolean;
}

export type CaseDetailLoad =
  | ({ kind: 'ok' } & CaseDetailData)
  | { kind: 'not_found' }
  // 不是組織身分
  | { kind: 'forbidden' };

/**
 * 載入一個案件的詳情。沒登入時丟 Unauthenticated，由頁面導向登入。
 * 只給 server component 用；route handler 走 inOrgTxAs，才能把拒絕轉成 401、403 的回應。
 */
export async function loadCaseDetail(id: string): Promise<CaseDetailLoad> {
  const rc = await requestContext();
  if (rc.kind !== 'org') return { kind: 'forbidden' };
  if (!isUlid(id)) return { kind: 'not_found' };
  try {
    return await withTx(toDbContext(rc), async (tx): Promise<CaseDetailLoad> => {
      bindAccessContext(tx, rc);
      await authorize(tx, 'case.read_summary', { type: 'case', id });
      const record = await getCase(tx, id);
      if (!record) return { kind: 'not_found' };
      const [orgName, members, contracts, events, manage] = await Promise.all([
        getOrgName(tx, record.orgId),
        listCaseMembers(tx, id),
        listContractsOfCase(tx, id),
        listCaseEvents(tx, id),
        checkAccess(tx, 'case_member.manage', { type: 'case', id }),
      ]);
      // 預設收款帳戶 ID 不給案件的所有成員：承租人用不到，要看走 ledger.read_case_setup（MIL-123）
      const { defaultRentAccountId: _rent, defaultDepositAccountId: _deposit, ...publicRecord } = record;
      void _rent;
      void _deposit;
      // 轉租案件連到的包租案件是主辦組織自己的案件（ADR-0030 決議 5），別組織的成員不需要它的 ID
      const isHost = record.orgId === rc.orgId;
      const { linkedMasterLeaseCaseId, ...rest } = publicRecord;
      return {
        kind: 'ok',
        case: isHost ? { ...rest, linkedMasterLeaseCaseId } : rest,
        orgName,
        isHost,
        members,
        contracts,
        events,
        canManageMembers: manage.allowed,
      };
    });
  } catch (error) {
    // 沒有權限與不存在對外是同一個畫面
    if (error instanceof Forbidden) return { kind: 'not_found' };
    throw error;
  }
}

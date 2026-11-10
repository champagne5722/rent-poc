import { NextRequest } from 'next/server';
import { authorize, checkAccess } from '@/lib/authorize';
import {
  getDefaultAccounts,
  getDepositBalance,
  getDepositLedger,
  listHolderConflicts,
  listRemitterIds,
  listSocialHousingChanges,
} from '@/lib/case-ledger';
import { getCase } from '@/lib/case-store';
import { caseIdOf, caseNotFound, type CaseRouteCtx } from '@/lib/case-store/route';
import { jsonOk } from '@/lib/http';
import { getDepositCollected, getPrepaidBalance, listPeriodViews, listReceipts } from '@/lib/ledger/receipts';
import { inOrgTx } from '@/lib/org-route';

// 案件的帳務設定（MIL-123）：押金台帳與餘額、應收期別、匯款識別、預設收款帳戶、社宅旗標的修改紀錄、持有人衝突。
// MIL-125 加：期別的入帳狀態與差額、押金累計已收、預收租金餘額、每筆入帳確認，與能不能登錄入帳。
// 權限是 ledger.read_case_setup：主辦組織的成員與出租人（代管案件是屋主）。承租人端不顯示應收期別，所以不在內。
// 案件不存在、別的組織的案件、沒有權限的案件，回應逐位元相同（P0-02 AC1）。
export async function GET(_request: NextRequest, { params }: CaseRouteCtx) {
  const id = await caseIdOf(params);
  if (!id) return caseNotFound();
  return inOrgTx(async (tx) => {
    await authorize(tx, 'ledger.read_case_setup', { type: 'case', id });
    const record = await getCase(tx, id);
    if (!record || record.kind !== 'lease') return caseNotFound();
    const [
      configure,
      setSocialHousing,
      recordPayment,
      depositLedger,
      depositBalance,
      depositCollected,
      prepaidBalance,
      periods,
      receipts,
      remitterIds,
      defaultAccounts,
      socialHousingChanges,
      holderConflicts,
    ] = await Promise.all([
      checkAccess(tx, 'ledger.configure_case', { type: 'case', id }),
      checkAccess(tx, 'case.set_social_housing', { type: 'case', id }),
      checkAccess(tx, 'ledger.record_payment', { type: 'case', id }),
      getDepositLedger(tx, id),
      getDepositBalance(tx, id),
      getDepositCollected(tx, id),
      getPrepaidBalance(tx, id),
      listPeriodViews(tx, id),
      listReceipts(tx, id),
      listRemitterIds(tx, id),
      getDefaultAccounts(tx, id),
      listSocialHousingChanges(tx, id),
      listHolderConflicts(tx, id),
    ]);
    return jsonOk({
      data: {
        socialHousing: record.socialHousing,
        // 畫面用它決定要不要顯示編輯控制項。真正的檢查在各個寫入的 route
        canConfigure: configure.allowed,
        canSetSocialHousing: setSocialHousing.allowed,
        canRecordPayment: recordPayment.allowed,
        depositLedger,
        depositBalance,
        // 押金累計已收（不含扣抵與返還）。約定金額減它就是差額
        depositCollected,
        prepaidBalance,
        periods,
        receipts,
        remitterIds,
        defaultAccounts,
        socialHousingChanges,
        holderConflicts,
      },
    });
  });
}

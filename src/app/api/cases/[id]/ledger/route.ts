import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import {
  getDefaultAccounts,
  getDepositBalance,
  getDepositLedger,
  listHolderConflicts,
  listPeriods,
  listRemitterIds,
  listSocialHousingChanges,
} from '@/lib/case-ledger';
import { getCase } from '@/lib/case-store';
import { caseIdOf, caseNotFound, type CaseRouteCtx } from '@/lib/case-store/route';
import { jsonOk } from '@/lib/http';
import { inOrgTx } from '@/lib/org-route';

// 案件的帳務設定（MIL-123）：押金台帳與餘額、應收期別、匯款識別、預設收款帳戶、社宅旗標的修改紀錄、持有人衝突。
// 權限是 ledger.read_case_setup：主辦組織的成員與出租人（代管案件是屋主）。承租人端不顯示應收期別，所以不在內。
// 案件不存在、別的組織的案件、沒有權限的案件，回應逐位元相同（P0-02 AC1）。
export async function GET(_request: NextRequest, { params }: CaseRouteCtx) {
  const id = await caseIdOf(params);
  if (!id) return caseNotFound();
  return inOrgTx(async (tx) => {
    await authorize(tx, 'ledger.read_case_setup', { type: 'case', id });
    const record = await getCase(tx, id);
    if (!record || record.kind !== 'lease') return caseNotFound();
    const [depositLedger, depositBalance, periods, remitterIds, defaultAccounts, socialHousingChanges, holderConflicts] = await Promise.all([
      getDepositLedger(tx, id),
      getDepositBalance(tx, id),
      listPeriods(tx, id),
      listRemitterIds(tx, id),
      getDefaultAccounts(tx, id),
      listSocialHousingChanges(tx, id),
      listHolderConflicts(tx, id),
    ]);
    return jsonOk({
      data: {
        socialHousing: record.socialHousing,
        depositLedger,
        depositBalance,
        periods,
        remitterIds,
        defaultAccounts,
        socialHousingChanges,
        holderConflicts,
      },
    });
  });
}

import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { changeSocialHousing, MAX_REASON_LENGTH } from '@/lib/case-ledger';
import { caseIdOf, caseNotFound, type CaseRouteCtx } from '@/lib/case-store/route';
import { jsonError, jsonOk } from '@/lib/http';
import { dispatchNotificationEmail, type NotifyReceipt } from '@/lib/notifications';
import { inOrgTxAs, readJson } from '@/lib/org-route';

// 修改社宅代管旗標（ADR-0050 決議 10，MIL-123）。權限是 case.set_social_housing：代管與包租案件的主辦組織 admin、staff。
// 必須填原因。同交易改旗標、寫修改紀錄與稽核、通知委託人。既有押金分錄不變。
// 改為社宅時，回應帶持有人與押金規則的衝突清單，畫面列出提示。
// 通知 email 在交易提交後才派送（ADR-0020 決議 5），派送失敗不影響已提交的修改。
export async function PUT(request: NextRequest, { params }: CaseRouteCtx) {
  const id = await caseIdOf(params);
  if (!id) return caseNotFound();
  const body = await readJson(request);
  const input = typeof body === 'object' && body !== null ? (body as { value?: unknown; reason?: unknown }) : {};
  if (typeof input.value !== 'boolean') return jsonError(400, '請指定社宅代管旗標要改成是或否');
  const value = input.value;
  const reason = typeof input.reason === 'string' ? input.reason : '';

  let receipts: NotifyReceipt[] = [];
  let orgId = '';
  const response = await inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'case.set_social_housing', { type: 'case', id });
    const result = await changeSocialHousing(tx, { caseId: id, value, reason, actorPartyId: rc.partyId });
    if (!result.ok) {
      switch (result.error) {
        case 'case_not_found':
          return caseNotFound();
        case 'not_applicable':
          return jsonError(409, '自管案件沒有代管業者，不適用社宅代管旗標');
        case 'unchanged':
          return jsonError(409, `社宅代管旗標已經是「${value ? '是' : '否'}」`);
        case 'reason_required':
          return jsonError(400, '請填寫修改原因');
        case 'reason_too_long':
          return jsonError(400, `修改原因不得超過 ${MAX_REASON_LENGTH} 字`);
      }
    }
    receipts = result.receipts;
    orgId = rc.orgId;
    return jsonOk({
      data: { socialHousing: result.changed.to, mandatorNotified: result.mandatorNotified, holderConflicts: result.conflicts },
    });
  });
  for (const receipt of receipts) {
    try {
      await dispatchNotificationEmail(orgId, receipt.outboxId);
    } catch (error) {
      // 修改已提交。派送失敗的列留在 outbox，由排程重試
      console.error('[case-ledger] 社宅旗標通知 email 派送失敗', error);
    }
  }
  return response;
}

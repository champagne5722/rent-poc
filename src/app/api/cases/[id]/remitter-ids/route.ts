import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { addRemitterId } from '@/lib/case-ledger';
import { caseIdOf, caseNotFound, type CaseRouteCtx } from '@/lib/case-store/route';
import { jsonError, jsonOk } from '@/lib/http';
import { inOrgTx, readJson } from '@/lib/org-route';

// 登錄匯款識別（ADR-0050 決議 6，MIL-123）：付款人戶名或付款帳號末五碼。權限是 ledger.configure_case。
// 輸入先正規化再存：全形與半形、前後空白、連續空白視為同一個。
export async function POST(request: NextRequest, { params }: CaseRouteCtx) {
  const id = await caseIdOf(params);
  if (!id) return caseNotFound();
  const body = await readJson(request);
  return inOrgTx(async (tx) => {
    await authorize(tx, 'ledger.configure_case', { type: 'case', id });
    const result = await addRemitterId(tx, id, body);
    if (result.ok) return jsonOk({ data: { id: result.id } }, { status: 201 });
    switch (result.error) {
      case 'invalid_input':
        return jsonError(400, result.message);
      case 'case_not_found':
        return caseNotFound();
      case 'duplicate':
        return jsonError(409, '這個匯款識別已經登錄');
    }
  });
}

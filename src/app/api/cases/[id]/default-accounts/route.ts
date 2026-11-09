import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { setDefaultAccounts, type DefaultAccountsInput } from '@/lib/case-ledger';
import { caseIdOf, caseNotFound, type CaseRouteCtx } from '@/lib/case-store/route';
import { jsonError, jsonOk } from '@/lib/http';
import { inOrgTx, readJson } from '@/lib/org-route';

// 設定案件的租金與押金預設收款帳戶（MIL-123）。權限是 ledger.configure_case。
// 欄位沒傳＝不變，傳 null＝清除。預設帳戶只用來預填入帳表單。
// 帳戶不存在、已停用、屬於別的組織，回應相同。
function parseAccountField(value: unknown): { ok: true; value: string | null | undefined } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value };
  return typeof value === 'string' ? { ok: true, value } : { ok: false };
}

export async function PUT(request: NextRequest, { params }: CaseRouteCtx) {
  const id = await caseIdOf(params);
  if (!id) return caseNotFound();
  const body = await readJson(request);
  const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const rent = parseAccountField(raw.rentAccountId);
  const deposit = parseAccountField(raw.depositAccountId);
  if (!rent.ok || !deposit.ok) return jsonError(400, '收款帳戶必須是帳戶 ID 或 null');
  const input: DefaultAccountsInput = {};
  if (rent.value !== undefined) input.rentAccountId = rent.value;
  if (deposit.value !== undefined) input.depositAccountId = deposit.value;

  return inOrgTx(async (tx) => {
    await authorize(tx, 'ledger.configure_case', { type: 'case', id });
    const result = await setDefaultAccounts(tx, id, input);
    if (result.ok) return jsonOk({ data: { ok: true } });
    return result.error === 'case_not_found' ? caseNotFound() : jsonError(400, '收款帳戶不存在、已停用或不屬於本組織');
  });
}

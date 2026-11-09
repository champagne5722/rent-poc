import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { jsonError, jsonOk } from '@/lib/http';
import { inOrgTx, readJson } from '@/lib/org-route';
import { getPaymentAccount, parsePaymentAccountInput, updatePaymentAccount } from '@/lib/payment-accounts';
import { currentPartyId, paymentAccountError } from '@/lib/payment-accounts/http';
import { isUlid } from '@/lib/pg/ulid';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  // 格式錯誤的 ID、別的組織的 ID、不存在的 ID，三者的回應必須相同（P0-02 AC1）
  if (!isUlid(id)) return paymentAccountError('not_found');
  return inOrgTx(async (tx) => {
    await authorize(tx, 'payment_account.read', { type: 'org' });
    const account = await getPaymentAccount(tx, id);
    return account ? jsonOk({ data: account }) : paymentAccountError('not_found');
  });
}

export async function PUT(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return paymentAccountError('not_found');
  const body = await readJson(request);
  const party = await currentPartyId();
  if (!party.ok) return party.response;
  return inOrgTx(async (tx) => {
    await authorize(tx, 'payment_account.manage', { type: 'org' });
    // 先確認帳戶存在再驗本文：本文有誤時，也不洩漏別的組織的帳戶存在
    if (!(await getPaymentAccount(tx, id))) return paymentAccountError('not_found');
    const parsed = parsePaymentAccountInput(body);
    if (!parsed.ok) return jsonError(400, parsed.error);
    const result = await updatePaymentAccount(tx, id, parsed.value, party.partyId);
    return result.ok ? jsonOk({ data: { id } }) : paymentAccountError(result.error);
  });
}

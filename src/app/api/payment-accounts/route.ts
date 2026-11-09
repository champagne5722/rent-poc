import { NextRequest } from 'next/server';
import { jsonError, jsonOk } from '@/lib/http';
import { inOrgTx, readJson } from '@/lib/org-route';
import { listPaymentAccounts, parsePaymentAccountInput, registerPaymentAccount } from '@/lib/payment-accounts';
import { currentPartyId, paymentAccountError } from '@/lib/payment-accounts/http';

// 收款帳戶（MIL-118）。只存遮罩識別：銀行代碼與帳號末四碼。

export async function GET() {
  return inOrgTx(async (tx) => jsonOk({ data: await listPaymentAccounts(tx) }));
}

export async function POST(request: NextRequest) {
  const parsed = parsePaymentAccountInput(await readJson(request));
  if (!parsed.ok) return jsonError(400, parsed.error);
  const party = await currentPartyId();
  if (!party.ok) return party.response;
  return inOrgTx(async (tx) => {
    const result = await registerPaymentAccount(tx, parsed.value, party.partyId);
    if (!result.ok) return paymentAccountError(result.error);
    return jsonOk({ data: { id: result.id, cashAccountId: result.cashAccountId } }, { status: 201 });
  });
}

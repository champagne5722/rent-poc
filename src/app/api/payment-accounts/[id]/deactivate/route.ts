import { NextRequest } from 'next/server';
import { jsonOk } from '@/lib/http';
import { inOrgTx } from '@/lib/org-route';
import { deactivatePaymentAccount } from '@/lib/payment-accounts';
import { paymentAccountError } from '@/lib/payment-accounts/http';
import { isUlid } from '@/lib/pg/ulid';

type Ctx = { params: Promise<{ id: string }> };

// 停用是單向的：沒有重新啟用，也沒有刪除。要再用請新增帳戶。
export async function POST(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return paymentAccountError('not_found');
  return inOrgTx(async (tx) => {
    const result = await deactivatePaymentAccount(tx, id);
    return result.ok ? jsonOk({ data: { id } }) : paymentAccountError(result.error);
  });
}

import { authorize, bindAccessContext, Forbidden } from '../authorize';
import { requestContext } from '../current-request-context';
import { withTx } from '../pg/database';
import { toDbContext } from '../request-context';
import { listPaymentAccounts, type PaymentAccount } from './repository';

// 收款帳戶頁的資料載入（MIL-181）。頁面在 server component 呼叫它，規則與 GET /api/payment-accounts 相同。
// 只給 server component 用；route handler 走 inOrgTx，才能把拒絕轉成 401、403 的回應。

export type PaymentAccountListLoad =
  | { kind: 'ok'; items: PaymentAccount[] }
  // 不是組織身分，或身分沒有查看收款帳戶的權限
  | { kind: 'forbidden' };

/** 載入目前組織的收款帳戶（含已停用）。沒登入時丟 Unauthenticated，由頁面導向登入。 */
export async function loadPaymentAccountList(): Promise<PaymentAccountListLoad> {
  const rc = await requestContext();
  if (rc.kind !== 'org') return { kind: 'forbidden' };
  try {
    return await withTx(toDbContext(rc), async (tx) => {
      bindAccessContext(tx, rc);
      await authorize(tx, 'payment_account.read', { type: 'org' });
      return { kind: 'ok' as const, items: await listPaymentAccounts(tx) };
    });
  } catch (error) {
    if (error instanceof Forbidden) return { kind: 'forbidden' };
    throw error;
  }
}

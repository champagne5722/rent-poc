import { appendAudit } from '../audit';
import { assertPaymentAccountsInOrg } from '../payment-accounts';
import type { OrgTx } from '../pg/with-tx';
import type { DefaultAccounts } from './types';

// 案件的租金與押金預設收款帳戶（spec「收款帳戶」，MIL-123）。只用來預填入帳表單，不影響配對與分錄。
// 呼叫端先 authorize()。tx 是呼叫端的組織交易，稽核事件與寫入同一個交易。

export interface DefaultAccountsInput {
  /** 沒傳＝不變，null＝清除。 */
  rentAccountId?: string | null;
  depositAccountId?: string | null;
}

export type SetDefaultAccountsResult = { ok: true } | { ok: false; error: 'case_not_found' | 'account_not_usable' };

/** 案件目前的預設帳戶。看不到的案件（含別的組織）回 null。 */
export async function getDefaultAccounts(tx: OrgTx, caseId: string): Promise<DefaultAccounts | null> {
  const { rows } = await tx.query<{ rent: string | null; deposit: string | null }>(
    `SELECT default_rent_account_id AS rent, default_deposit_account_id AS deposit FROM org.cases WHERE id = $1`,
    [caseId],
  );
  return rows[0] ? { rentAccountId: rows[0].rent, depositAccountId: rows[0].deposit } : null;
}

/**
 * 設定或清除預設帳戶。帳戶必須屬於本組織且啟用中（停用的帳戶不得再收款）。
 * 帳戶檢查用 assertPaymentAccountsInOrg，對帳戶列加共享鎖，所以停用中的交易會等這筆寫入。
 */
export async function setDefaultAccounts(tx: OrgTx, caseId: string, input: DefaultAccountsInput): Promise<SetDefaultAccountsResult> {
  const current = await tx.query<{ rent: string | null; deposit: string | null }>(
    `SELECT default_rent_account_id AS rent, default_deposit_account_id AS deposit FROM org.cases WHERE id = $1 FOR UPDATE`,
    [caseId],
  );
  if (current.rows.length === 0) return { ok: false, error: 'case_not_found' };

  const rent = input.rentAccountId === undefined ? current.rows[0].rent : input.rentAccountId;
  const deposit = input.depositAccountId === undefined ? current.rows[0].deposit : input.depositAccountId;
  // 只檢查這次要改的欄位：沒傳的欄位維持原值，原值的帳戶之後才被停用也不該擋住修改另一個欄位
  const changed = [
    input.rentAccountId === undefined ? null : input.rentAccountId,
    input.depositAccountId === undefined ? null : input.depositAccountId,
  ].filter((id): id is string => id !== null);
  const usable = await assertPaymentAccountsInOrg(tx, changed);
  if (!usable.ok) return { ok: false, error: 'account_not_usable' };

  if (rent === current.rows[0].rent && deposit === current.rows[0].deposit) return { ok: true };
  await tx.query(`UPDATE org.cases SET default_rent_account_id = $2, default_deposit_account_id = $3, updated_at = now() WHERE id = $1`, [
    caseId,
    rent,
    deposit,
  ]);
  const payload: Record<string, string | null> = {};
  if (input.rentAccountId !== undefined) payload.rent_account_id = input.rentAccountId;
  if (input.depositAccountId !== undefined) payload.deposit_account_id = input.depositAccountId;
  await appendAudit(tx, { action: 'case.default_accounts_set', object: { type: 'case', id: caseId }, payload });
  return { ok: true };
}

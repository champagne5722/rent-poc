// 收款帳戶（MIL-118）與押金帳戶規則。
import { newUlid } from '../ulid';
import type { ControlTableException, OrgTableCase, RlsRegistration } from './types';

const orgTables: Record<string, OrgTableCase> = {
  // 收款帳戶（MIL-118）：可改（停用、改名），不可刪（觸發器擋下自己組織的列，別的組織的列 RLS 讓它刪不到）。
  // 持有人是 other，不需要 party。現金收取帳戶的唯一鍵含 org_id，兩個組織用同一個持有人各寫一列都成功。
  'org.payment_accounts': {
    async seed(tx, orgId) {
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.payment_accounts (id, org_id, name, holder_kind, holder_name, account_kind)
         VALUES ($1, $2, '滲透測試現金收取', 'other', '滲透測試持有人', 'cash')`,
        [id, orgId],
      );
      return id;
    },
  },
};

const controlTables: Record<string, ControlTableException> = {
  'control.deposit_holder_rules': {
    reason: '押金帳戶規則，平台層級，組織不得覆寫，只由 migration 改列。MIL-118，ADR-0014 決議 13',
    appRw: ['SELECT'],
  },
};

export const paymentAccountsRls: RlsRegistration = { orgTables, controlTables };

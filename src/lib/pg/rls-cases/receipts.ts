// 入帳確認、配置與持有人確認紀錄（MIL-125，migration 0075）。三張表都是 org 表，沒有 registry 函式，所以沒有個資揭露登記。
import { newUlid } from '../ulid';
import type { OrgTx } from '../with-tx';
import { seedLedgerCase, seedLedgerJournal } from './ledger';
import type { CaseScopedRead, OrgTableCase, RlsRegistration } from './types';

/** 建收款帳戶。銀行帳戶沒有唯一限制，所以同一個組織呼叫多次也不會撞。 */
async function seedAccount(tx: OrgTx, orgId: string): Promise<string> {
  const id = newUlid();
  await tx.query(
    `INSERT INTO org.payment_accounts (id, org_id, name, holder_kind, holder_name, account_kind, bank_code, account_last4)
     VALUES ($1, $2, '滲透測試銀行帳戶', 'other', '滲透測試持有人', 'general', '812', '0123')`,
    [id, orgId],
  );
  return id;
}

/** 建一筆入帳確認。去重鍵固定：兩個組織各寫一列都要成功（陷阱 6）。案件、帳戶與分錄各自新建。 */
async function seedConfirmation(tx: OrgTx, orgId: string): Promise<{ id: string; caseId: string; accountId: string }> {
  const { journalId, caseId } = await seedLedgerJournal(tx, orgId);
  const accountId = await seedAccount(tx, orgId);
  const id = newUlid();
  await tx.query(
    `INSERT INTO org.receipt_confirmations
       (id, org_id, case_id, purpose, amount, value_date, payment_account_id, source, external_id, journal_id)
     VALUES ($1, $2, $3, 'security_deposit', 100, '2026-11-08', $4, 'manual', 'PENETRATION-1', $5)`,
    [id, orgId, caseId, accountId, journalId],
  );
  return { id, caseId, accountId };
}

const orgTables: Record<string, OrgTableCase> = {
  // 入帳確認：只增不改，app_rw 沒有 UPDATE 與 DELETE 權限
  'org.receipt_confirmations': {
    appendOnly: true,
    seed: (tx, orgId) => seedConfirmation(tx, orgId).then((seeded) => seeded.id),
  },
  // 配置：只有 active 能由 true 改 false，其餘欄位與刪除由觸發器擋下。別的組織的列 RLS 讓它改不到、刪不到
  'org.receipt_allocations': {
    blockedUpdateMessage: /配置的金額、期別與來源寫入後不得修改/,
    async seed(tx, orgId) {
      const caseId = await seedLedgerCase(tx, orgId);
      const periodId = newUlid();
      await tx.query(
        `INSERT INTO org.receivable_periods (id, org_id, case_id, period_key, period_start, period_end, due_date, amount)
         VALUES ($1, $2, $3, '2026-11', '2026-11-01', '2026-11-30', '2026-11-05', 30000)`,
        [periodId, orgId, caseId],
      );
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.receipt_allocations (id, org_id, case_id, period_id, source, source_id, amount) VALUES ($1, $2, $3, $4, 'receipt', 'PENETRATION-1', 100)`,
        [id, orgId, caseId, periodId],
      );
      return id;
    },
  },
  // 持有人確認紀錄：只增不改
  'org.deposit_holder_acknowledgments': {
    appendOnly: true,
    async seed(tx, orgId) {
      const confirmation = await seedConfirmation(tx, orgId);
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.deposit_holder_acknowledgments
           (id, org_id, case_id, receipt_confirmation_id, payment_account_id, action, message_key)
         VALUES ($1, $2, $3, $4, $5, 'warn', 'deposit_holder.warn.rule_unmatched')`,
        [id, orgId, confirmation.caseId, confirmation.id, confirmation.accountId],
      );
      return id;
    },
  },
};

const caseScopedReads: Record<string, CaseScopedRead> = {
  'org.receipt_confirmations': {
    readableBy: ['lessor'],
    note: '入帳確認（MIL-125）。屋主（代管案件的 lessor）讀得到來源與登錄者。承租人端不顯示登錄者、證明檔與持有人確認紀錄',
  },
  'org.receipt_allocations': {
    readableBy: ['lessor'],
    note: '入帳配置（MIL-125）。與應收期別相同：承租人端不顯示應收期別與逾期',
  },
  'org.deposit_holder_acknowledgments': {
    readableBy: ['lessor'],
    note: '持有人確認紀錄（MIL-125）。屋主看得到自己的押金是否經過規則警告',
  },
};

export const receiptsRls: RlsRegistration = { orgTables, caseScopedReads };

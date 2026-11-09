// 鏡像帳（MIL-117）與接上案件的表（MIL-123）：押金台帳、應收期別、匯款識別、社宅旗標修改紀錄。
import { newUlid } from '../ulid';
import type { OrgTx } from '../with-tx';
import type { CaseScopedRead, OrgTableCase, RlsRegistration } from './types';

/** 建一個案件。鏡像帳與接上案件的表都掛 cases 的複合外鍵（MIL-123）。案件 ID 全域唯一，所以每次呼叫建新的。 */
async function seedLedgerCase(tx: OrgTx, orgId: string): Promise<string> {
  const caseId = newUlid();
  await tx.query(
    `INSERT INTO org.cases (id, org_id, kind, state, business_type, title)
     VALUES ($1, $2, 'lease', 'active', 'self_managed', '滲透測試案件')`,
    [caseId, orgId],
  );
  return caseId;
}

/** 寫一筆平衡的分錄（兩列明細）。分錄的檢查在提交時執行，所以兩個 INSERT 要在同一個交易內。 */
async function seedLedgerJournal(tx: OrgTx, orgId: string): Promise<{ journalId: string; entryId: string }> {
  const caseId = await seedLedgerCase(tx, orgId);
  const journalId = newUlid();
  const entryId = newUlid();
  await tx.query(
    `INSERT INTO org.ledger_journals (id, org_id, case_id, business_event_type, business_event_id, effective_date)
     VALUES ($1, $2, $3, 'receipt_confirmed', 'PENETRATION-1', '2026-11-08')`,
    [journalId, orgId, caseId],
  );
  await tx.query(
    `INSERT INTO org.ledger_entries (id, org_id, case_id, journal_id, line_no, account, debit, credit) VALUES
       ($1, $2, $3, $4, 1, 'asset.bank.PENETRATION', 100, 0),
       ($5, $2, $3, $4, 2, $6, 0, 100)`,
    [newUlid(), orgId, caseId, journalId, entryId, `liability.deposit.${caseId}`],
  );
  return { journalId, entryId };
}

const orgTables: Record<string, OrgTableCase> = {
  // 鏡像帳（MIL-117）：只增不改。直接 INSERT 而不用 ledger 模組，因為探測 4 要在 A 的脈絡寫入 B 的 org_id。
  // 業務鍵（事件類型、事件 ID）固定：兩個組織寫同一組業務鍵都要成功。案件各自新建（org.cases.id 全域唯一）。
  'org.ledger_journals': {
    appendOnly: true,
    seed: (tx, orgId) => seedLedgerJournal(tx, orgId).then((seeded) => seeded.journalId),
  },
  'org.ledger_entries': {
    appendOnly: true,
    seed: (tx, orgId) => seedLedgerJournal(tx, orgId).then((seeded) => seeded.entryId),
  },
  // 押金台帳（MIL-123）：約定金額與所屬案件寫入後不改，觸發器比 RLS 的 WITH CHECK 先執行；不可刪。
  'org.deposit_ledgers': {
    blockedUpdateMessage: /押金台帳的約定金額與所屬案件寫入後不得修改/,
    async seed(tx, orgId) {
      const caseId = await seedLedgerCase(tx, orgId);
      const id = newUlid();
      await tx.query(`INSERT INTO org.deposit_ledgers (id, org_id, case_id, expected_amount) VALUES ($1, $2, $3, 60000)`, [id, orgId, caseId]);
      return id;
    },
  },
  // 應收期別（MIL-123）：金額與日期寫入後不改，只有狀態與逾期時間能變；不可刪。
  'org.receivable_periods': {
    blockedUpdateMessage: /應收期別的金額與日期寫入後不得修改/,
    async seed(tx, orgId) {
      const caseId = await seedLedgerCase(tx, orgId);
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.receivable_periods (id, org_id, case_id, period_key, period_start, period_end, due_date, amount)
         VALUES ($1, $2, $3, '2026-11', '2026-11-01', '2026-11-30', '2026-11-05', 30000)`,
        [id, orgId, caseId],
      );
      return id;
    },
  },
  // 匯款識別（MIL-123）：可新增與刪除。同一組業務鍵（種類加值）兩個組織各寫一列都成功。
  'org.case_remitter_ids': {
    async seed(tx, orgId) {
      const caseId = await seedLedgerCase(tx, orgId);
      const id = newUlid();
      await tx.query(`INSERT INTO org.case_remitter_ids (id, org_id, case_id, kind, value) VALUES ($1, $2, $3, 'account_last5', '12345')`, [id, orgId, caseId]);
      return id;
    },
  },
  // 社宅旗標的修改紀錄（MIL-123）：只增不改，app_rw 沒有 UPDATE 與 DELETE 權限。
  'org.case_social_housing_changes': {
    appendOnly: true,
    async seed(tx, orgId) {
      const caseId = await seedLedgerCase(tx, orgId);
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.case_social_housing_changes (id, org_id, case_id, from_value, to_value, reason)
         VALUES ($1, $2, $3, false, true, '滲透測試原因')`,
        [id, orgId, caseId],
      );
      return id;
    },
  },
};

const caseScopedReads: Record<string, CaseScopedRead> = {
  'org.ledger_journals': {
    readableBy: ['lessor', 'lessee', 'co_lessee'],
    note: '鏡像帳分錄。與動作表 ledger.read 一致：出租人（代管案件是屋主）、承租人、共同承租人。MIL-123 接上 cases 時補政策（ADR-0015 決議 12）',
  },
  'org.ledger_entries': {
    readableBy: ['lessor', 'lessee', 'co_lessee'],
    note: '鏡像帳明細。同分錄',
  },
  'org.deposit_balances': {
    readableBy: ['lessor', 'lessee', 'co_lessee'],
    note: '押金餘額 view（MIL-123，security_invoker）。以呼叫者的身分讀 ledger_entries，所以可讀的關係與 ledger_entries 相同',
  },
  'org.deposit_ledgers': {
    readableBy: ['lessor', 'lessee', 'co_lessee'],
    note: '押金台帳（MIL-123）。承租人看自己案件的押金進度（承租人端 MIL-140）',
  },
  'org.receivable_periods': {
    readableBy: ['lessor'],
    note: '應收期別（MIL-123）。承租人端不顯示應收期別與逾期（列 P1 候選），屋主讀得到',
  },
  'org.case_remitter_ids': {
    readableBy: [],
    note: '匯款識別（MIL-123）。付款人戶名是個資，只有主辦組織讀得到',
  },
  'org.case_social_housing_changes': {
    readableBy: ['lessor'],
    note: '社宅旗標的修改紀錄（MIL-123）。屋主看得到旗標與修改原因（ADR-0050 決議 10）',
  },
};

export const ledgerRls: RlsRegistration = { orgTables, caseScopedReads };

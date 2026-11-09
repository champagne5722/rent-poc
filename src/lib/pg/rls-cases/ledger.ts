// 鏡像帳（MIL-117）。
import { newUlid } from '../ulid';
import type { OrgTx } from '../with-tx';
import type { CaseScopedRead, OrgTableCase, RlsRegistration } from './types';

/** 寫一筆平衡的分錄（兩列明細）。分錄的檢查在提交時執行，所以兩個 INSERT 要在同一個交易內。 */
async function seedLedgerJournal(tx: OrgTx, orgId: string): Promise<{ journalId: string; entryId: string }> {
  const journalId = newUlid();
  const entryId = newUlid();
  await tx.query(
    `INSERT INTO org.ledger_journals (id, org_id, case_id, business_event_type, business_event_id, effective_date)
     VALUES ($1, $2, 'PENETRATION', 'receipt_confirmed', 'PENETRATION-1', '2026-11-08')`,
    [journalId, orgId],
  );
  await tx.query(
    `INSERT INTO org.ledger_entries (id, org_id, case_id, journal_id, line_no, account, debit, credit) VALUES
       ($1, $2, 'PENETRATION', $3, 1, 'asset.bank.PENETRATION', 100, 0),
       ($4, $2, 'PENETRATION', $3, 2, 'liability.deposit.PENETRATION', 0, 100)`,
    [entryId, orgId, journalId, newUlid()],
  );
  return { journalId, entryId };
}

const orgTables: Record<string, OrgTableCase> = {
  // 鏡像帳（MIL-117）：只增不改。直接 INSERT 而不用 ledger 模組，因為探測 4 要在 A 的脈絡寫入 B 的 org_id。
  // 業務鍵（案件、事件類型、事件 ID）固定：兩個組織寫同一組業務鍵都要成功。
  'org.ledger_journals': {
    appendOnly: true,
    seed: (tx, orgId) => seedLedgerJournal(tx, orgId).then((seeded) => seeded.journalId),
  },
  'org.ledger_entries': {
    appendOnly: true,
    seed: (tx, orgId) => seedLedgerJournal(tx, orgId).then((seeded) => seeded.entryId),
  },
};

const caseScopedReads: Record<string, CaseScopedRead> = {
  'org.ledger_journals': {
    readableBy: [],
    note: '鏡像帳分錄（MIL-117）。case_id 是文字，還沒掛 cases 的外鍵，只有主辦組織讀取。成員讀取政策由 MIL-123 接上案件時補',
  },
  'org.ledger_entries': {
    readableBy: [],
    note: '鏡像帳明細（MIL-117）。同分錄，只有主辦組織讀取，MIL-123 接上案件時補成員讀取政策',
  },
};

export const ledgerRls: RlsRegistration = { orgTables, caseScopedReads };

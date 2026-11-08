// 鏡像帳的資料庫存取（MIL-117）。只給同目錄的 post.ts 與之後的業務函式使用，不從 index.ts 匯出。
// 這裡只做 SQL 與型別轉換，不做業務判斷。平衡、沖銷與唯一性的最後一道防線在資料庫的觸發器與約束（db/migrations/0050_ledger.sql）。

import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import type { Journal } from './types';

const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/** 目前交易的組織脈絡與資料庫時間。org_id 取自 withTx 設定的 app.org_id，不讓呼叫端另外傳。 */
export async function readContext(tx: OrgTx): Promise<{ orgId: string; now: string }> {
  const { rows } = await tx.query<{ org_id: string | null; now: string }>(
    `SELECT nullif(current_setting('app.org_id', true), '') AS org_id,
            to_char(now() AT TIME ZONE 'UTC', ${ISO_UTC}) AS now`,
  );
  const orgId = rows[0].org_id;
  if (!orgId) throw new Error('鏡像帳必須在組織脈絡內寫入：app.org_id 未設定');
  return { orgId, now: rows[0].now };
}

/**
 * 寫入分錄與明細。回傳 false 表示撞到唯一鍵（業務事件鍵，或這筆分錄已被沖銷），什麼都沒寫。
 * 明細在同一個交易、緊接著分錄之後寫入：資料庫的觸發器不准其他交易追加明細。
 */
export async function insertJournal(tx: OrgTx, journal: Journal): Promise<boolean> {
  const inserted = await tx.query(
    `INSERT INTO org.ledger_journals
       (id, org_id, case_id, business_event_type, business_event_id, reverses_journal_id, reason, posted_at, effective_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::date)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      journal.journalId,
      journal.orgId,
      journal.caseId,
      journal.eventType,
      journal.eventId,
      journal.reversesJournalId,
      journal.reason,
      journal.postedAt,
      journal.effectiveDate,
    ],
  );
  if (inserted.rows.length === 0) return false;

  const params: unknown[] = [];
  const tuples = journal.lines.map((line, index) => {
    const base = params.length;
    params.push(newUlid(), journal.orgId, journal.caseId, journal.journalId, index + 1, line.account, line.debit, line.credit);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
  });
  await tx.query(
    `INSERT INTO org.ledger_entries (id, org_id, case_id, journal_id, line_no, account, debit, credit) VALUES ${tuples.join(', ')}`,
    params,
  );
  return true;
}

function toAmount(text: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new RangeError(`資料庫中的金額超過安全整數範圍：${text}`);
  return value;
}

/** 讀一筆分錄與明細。RLS 只讓目前組織的列通過，所以找不到也可能是別的組織的分錄。 */
export async function loadJournal(tx: OrgTx, orgId: string, journalId: string): Promise<Journal | null> {
  const head = await tx.query<{
    case_id: string;
    business_event_type: string;
    business_event_id: string;
    reverses_journal_id: string | null;
    reason: string | null;
    posted_at: string;
    effective_date: string;
  }>(
    `SELECT case_id, business_event_type, business_event_id, reverses_journal_id, reason,
            to_char(posted_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS posted_at, effective_date::text AS effective_date
       FROM org.ledger_journals WHERE org_id = $1 AND id = $2`,
    [orgId, journalId],
  );
  if (head.rows.length === 0) return null;
  const row = head.rows[0];

  const entries = await tx.query<{ account: string; debit: string; credit: string }>(
    `SELECT account, debit::text AS debit, credit::text AS credit
       FROM org.ledger_entries WHERE org_id = $1 AND journal_id = $2 ORDER BY line_no`,
    [orgId, journalId],
  );
  const common = {
    journalId,
    orgId,
    caseId: row.case_id,
    eventType: row.business_event_type,
    eventId: row.business_event_id,
    postedAt: row.posted_at,
    effectiveDate: row.effective_date,
    lines: entries.rows.map((e) => ({ account: e.account, debit: toAmount(e.debit), credit: toAmount(e.credit) })),
  };
  // 資料庫的 CHECK 保證 reverses_journal_id 與 reason 同有或同無
  return row.reverses_journal_id !== null && row.reason !== null
    ? { ...common, reversesJournalId: row.reverses_journal_id, reason: row.reason }
    : { ...common, reversesJournalId: null, reason: null };
}

/** 這筆分錄是否已有沖銷。 */
export async function hasReversal(tx: OrgTx, orgId: string, journalId: string): Promise<boolean> {
  const { rows } = await tx.query(`SELECT 1 FROM org.ledger_journals WHERE org_id = $1 AND reverses_journal_id = $2`, [orgId, journalId]);
  return rows.length > 0;
}

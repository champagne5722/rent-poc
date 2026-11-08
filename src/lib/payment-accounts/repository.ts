import { appendAudit } from '../audit';
import type { HolderKind } from '../deposit-rules';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import type { PaymentAccountInput } from './input';

// 收款帳戶的 repository（MIL-118，ADR-0014 決議 9、10，ADR-0050 決議 9）。
// 寫法照 properties：第一個參數是 OrgTx，org_id 取交易的 app.org_id，別的組織的列與不存在的列沒有差別。
//
// - 只存遮罩識別（銀行代碼、帳號末四碼）。account_kind 是內部識別字，不出現在回傳值：
//   介面只需要知道「是不是現金收取」，所以回傳 isCash。
// - 持有人的 party：lessor、owner、manager 由呼叫端帶（route 取目前登入者），other 沒有 party，以姓名識別。
//   MIL-123 與 C 線併入後，選單換成成員清單，並補 holder_party_id 的外鍵。
// - 每位持有人一個現金收取帳戶：登錄與修改時，同交易補上持有人缺的那一個。
// - 有分錄引用後，持有人與遮罩識別不得修改。這裡先檢查回 locked，資料庫觸發器是最後一道防線。

interface Row {
  id: string;
  name: string;
  holder_kind: HolderKind;
  holder_party_id: string | null;
  holder_name: string;
  account_kind: 'general' | 'cash';
  bank_code: string | null;
  account_last4: string | null;
  created_at: Date;
  deactivated_at: Date | null;
  locked: boolean;
}

export interface PaymentAccount {
  id: string;
  name: string;
  holderKind: HolderKind;
  holderPartyId: string | null;
  holderName: string;
  /** 現金收取。介面標示「現金收取」，沒有銀行欄位。 */
  isCash: boolean;
  bankCode: string | null;
  accountLast4: string | null;
  active: boolean;
  /** 已有分錄引用：持有人與遮罩識別不得修改，要改請停用並新增。 */
  locked: boolean;
  createdAt: string;
}

// locked 的子查詢走 ledger_entries (org_id, account) 索引。RLS 讓它只看得到本組織的分錄
const SELECT_ACCOUNTS = `
  SELECT a.id, a.name, a.holder_kind, a.holder_party_id, a.holder_name, a.account_kind, a.bank_code,
         a.account_last4, a.created_at, a.deactivated_at,
         EXISTS (SELECT 1 FROM org.ledger_entries e WHERE e.org_id = a.org_id AND e.account = 'asset.bank.' || a.id) AS locked
    FROM org.payment_accounts a`;

function toAccount(row: Row): PaymentAccount {
  return {
    id: row.id,
    name: row.name,
    holderKind: row.holder_kind,
    holderPartyId: row.holder_party_id,
    holderName: row.holder_name,
    isCash: row.account_kind === 'cash',
    bankCode: row.bank_code,
    accountLast4: row.account_last4,
    active: row.deactivated_at === null,
    locked: row.locked,
    createdAt: row.created_at.toISOString(),
  };
}

/** 新的在前，含已停用的。ULID 隨時間遞增，所以 id DESC 就是建立時間由新到舊。 */
export async function listPaymentAccounts(tx: OrgTx): Promise<PaymentAccount[]> {
  const { rows } = await tx.query<Row>(`${SELECT_ACCOUNTS} ORDER BY a.id DESC`);
  return rows.map(toAccount);
}

export async function getPaymentAccount(tx: OrgTx, id: string): Promise<PaymentAccount | null> {
  const { rows } = await tx.query<Row>(`${SELECT_ACCOUNTS} WHERE a.id = $1`, [id]);
  return rows[0] ? toAccount(rows[0]) : null;
}

/** 持有人 party：other 一律沒有，其餘必須有。 */
function resolveParty(kind: HolderKind, partyId: string | null | undefined): string | null | 'missing' {
  if (kind === 'other') return null;
  return partyId ? partyId : 'missing';
}

/** 同一位持有人（種類加 party，other 以姓名）現有的啟用中現金收取帳戶。 */
async function activeCashAccountId(tx: OrgTx, kind: HolderKind, partyId: string | null, name: string): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM org.payment_accounts
      WHERE account_kind = 'cash' AND deactivated_at IS NULL AND holder_kind = $1
        AND COALESCE(holder_party_id, 'name:' || holder_name) = COALESCE($2::text, 'name:' || $3::text)`,
    [kind, partyId, name],
  );
  return rows[0]?.id ?? null;
}

async function insertAccount(
  tx: OrgTx,
  fields: { name: string; holderKind: HolderKind; holderPartyId: string | null; holderName: string; cash: boolean; bankCode: string | null; accountLast4: string | null },
): Promise<string> {
  const id = newUlid();
  await tx.query(
    `INSERT INTO org.payment_accounts
       (id, org_id, name, holder_kind, holder_party_id, holder_name, account_kind, bank_code, account_last4)
     VALUES ($1, current_setting('app.org_id', true), $2, $3, $4, $5, $6, $7, $8)`,
    [id, fields.name, fields.holderKind, fields.holderPartyId, fields.holderName, fields.cash ? 'cash' : 'general', fields.bankCode, fields.accountLast4],
  );
  await appendAudit(tx, {
    action: 'payment_account.register',
    object: { type: 'payment_account', id },
    // 不放姓名與銀行識別：canonical 寫入後刪不掉（ADR-0019 決議 5）
    payload: { holder_kind: fields.holderKind, method: fields.cash ? 'cash' : 'bank' },
  });
  return id;
}

/** 持有人沒有啟用中的現金收取帳戶時補一個。回傳新帳戶 ID，已經有則回 null。 */
async function ensureCashAccount(tx: OrgTx, kind: HolderKind, partyId: string | null, holderName: string): Promise<string | null> {
  if (await activeCashAccountId(tx, kind, partyId, holderName)) return null;
  return insertAccount(tx, {
    // 名稱上限 60 字，持有人名稱最長 60 字，所以截短再加後綴
    name: `${holderName.slice(0, 50)} 現金收取`,
    holderKind: kind,
    holderPartyId: partyId,
    holderName,
    cash: true,
    bankCode: null,
    accountLast4: null,
  });
}

export type RegisterResult =
  | { ok: true; id: string; /** 同交易補上的現金收取帳戶。持有人本來就有則為 null。 */ cashAccountId: string | null }
  | { ok: false; error: 'cash_exists' | 'holder_party_required' };

/**
 * 登錄收款帳戶。登錄銀行帳戶時，同交易為持有人補現金收取帳戶（ADR-0050 決議 9）。
 * 明確登錄現金收取而持有人已有時回 cash_exists。
 */
export async function registerPaymentAccount(
  tx: OrgTx,
  input: PaymentAccountInput,
  holderPartyId: string | null,
): Promise<RegisterResult> {
  const party = resolveParty(input.holderKind, holderPartyId);
  if (party === 'missing') return { ok: false, error: 'holder_party_required' };

  const cash = input.method === 'cash';
  if (cash && (await activeCashAccountId(tx, input.holderKind, party, input.holderName))) {
    return { ok: false, error: 'cash_exists' };
  }
  const id = await insertAccount(tx, {
    name: input.name,
    holderKind: input.holderKind,
    holderPartyId: party,
    holderName: input.holderName,
    cash,
    bankCode: input.bankCode,
    accountLast4: input.accountLast4,
  });
  const cashAccountId = cash ? null : await ensureCashAccount(tx, input.holderKind, party, input.holderName);
  return { ok: true, id, cashAccountId };
}

export type UpdateResult =
  | { ok: true }
  | { ok: false; error: 'not_found' | 'inactive' | 'locked' | 'method_change' | 'cash_exists' | 'holder_party_required' };

const AUDITED_FIELDS = [
  ['name', 'name'],
  ['holder_kind', 'holder_kind'],
  ['holder_name', 'holder_name'],
  ['bank_code', 'bank_code'],
  ['account_last4', 'account_last4'],
] as const;

/**
 * 修改收款帳戶。有分錄引用後，持有人與遮罩識別不得改，只能改名稱，回 locked。
 * holderPartyId 沒給時沿用原值（原本是 other、改成其他種類時必須給）。
 */
export async function updatePaymentAccount(
  tx: OrgTx,
  id: string,
  input: PaymentAccountInput,
  holderPartyId?: string | null,
): Promise<UpdateResult> {
  // 鎖住這一列再讀：兩個修改重疊時，後到的看到的是前一個提交後的值
  const { rows } = await tx.query<Row>(`${SELECT_ACCOUNTS} WHERE a.id = $1 FOR UPDATE OF a`, [id]);
  if (!rows[0]) return { ok: false, error: 'not_found' };
  const before = rows[0];
  if (before.deactivated_at !== null) return { ok: false, error: 'inactive' };
  if ((input.method === 'cash') !== (before.account_kind === 'cash')) return { ok: false, error: 'method_change' };

  const party = resolveParty(input.holderKind, holderPartyId === undefined ? before.holder_party_id : holderPartyId);
  if (party === 'missing') return { ok: false, error: 'holder_party_required' };

  const holderChanged =
    input.holderKind !== before.holder_kind || input.holderName !== before.holder_name || party !== before.holder_party_id;
  const maskChanged = input.bankCode !== before.bank_code || input.accountLast4 !== before.account_last4;
  if ((holderChanged || maskChanged) && before.locked) return { ok: false, error: 'locked' };

  if (holderChanged && before.account_kind === 'cash') {
    const existing = await activeCashAccountId(tx, input.holderKind, party, input.holderName);
    if (existing && existing !== id) return { ok: false, error: 'cash_exists' };
  }

  const changed = AUDITED_FIELDS.filter(([field]) => {
    const next: Record<string, string | null> = {
      name: input.name,
      holder_kind: input.holderKind,
      holder_name: input.holderName,
      bank_code: input.bankCode,
      account_last4: input.accountLast4,
    };
    return next[field] !== (before as unknown as Record<string, string | null>)[field];
  }).map(([, label]) => label);

  if (changed.length === 0 && !holderChanged) return { ok: true };

  await tx.query(
    `UPDATE org.payment_accounts
        SET name = $2, holder_kind = $3, holder_party_id = $4, holder_name = $5, bank_code = $6, account_last4 = $7
      WHERE id = $1`,
    [id, input.name, input.holderKind, party, input.holderName, input.bankCode, input.accountLast4],
  );
  if (holderChanged && before.account_kind !== 'cash') await ensureCashAccount(tx, input.holderKind, party, input.holderName);
  // 只列被改的欄位名稱，不含值
  await appendAudit(tx, { action: 'payment_account.update', object: { type: 'payment_account', id }, payload: { changed } });
  return { ok: true };
}

export type DeactivateResult = { ok: true } | { ok: false; error: 'not_found' | 'already_inactive' };

/** 停用。有分錄引用的帳戶也能停用。停用是單向的，不能重新啟用。 */
export async function deactivatePaymentAccount(tx: OrgTx, id: string): Promise<DeactivateResult> {
  const { rows } = await tx.query<{ deactivated_at: Date | null; holder_kind: HolderKind; account_kind: string }>(
    'SELECT deactivated_at, holder_kind, account_kind FROM org.payment_accounts WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!rows[0]) return { ok: false, error: 'not_found' };
  if (rows[0].deactivated_at !== null) return { ok: false, error: 'already_inactive' };
  await tx.query('UPDATE org.payment_accounts SET deactivated_at = now() WHERE id = $1', [id]);
  await appendAudit(tx, {
    action: 'payment_account.deactivate',
    object: { type: 'payment_account', id },
    payload: { holder_kind: rows[0].holder_kind, method: rows[0].account_kind === 'cash' ? 'cash' : 'bank' },
  });
  return { ok: true };
}

export type AssertAccountsResult = { ok: true } | { ok: false; notFound: string[]; inactive: string[] };

/**
 * 檢查收款帳戶都屬於本組織（MIL-117 留下的「asset.bank.{id} 屬於本組織」）。
 * 鏡像帳的科目編碼只檢查格式，業務函式（MIL-125 的 confirmReceipt）寫分錄前呼叫這個。
 * 別的組織的帳戶與不存在的帳戶一律算 notFound，不洩漏它屬於誰。
 * 已停用的帳戶預設不通過：停用後不得再收款。沖銷舊分錄時帳戶可能已停用，傳 allowInactive。
 */
export async function assertPaymentAccountsInOrg(
  tx: OrgTx,
  ids: readonly string[],
  options: { allowInactive?: boolean } = {},
): Promise<AssertAccountsResult> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { ok: true };
  const valid = unique.filter((id) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id));
  const found = new Map<string, boolean>();
  if (valid.length > 0) {
    const { rows } = await tx.query<{ id: string; deactivated_at: Date | null }>(
      'SELECT id, deactivated_at FROM org.payment_accounts WHERE id = ANY($1::text[])',
      [valid],
    );
    for (const row of rows) found.set(row.id, row.deactivated_at === null);
  }
  const notFound = unique.filter((id) => !found.has(id));
  const inactive = options.allowInactive ? [] : unique.filter((id) => found.get(id) === false);
  return notFound.length === 0 && inactive.length === 0 ? { ok: true } : { ok: false, notFound, inactive };
}

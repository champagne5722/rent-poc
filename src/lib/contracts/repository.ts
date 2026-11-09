import { appendAudit } from '@/lib/audit';
import type { ContractType } from '@/lib/labels';
import { newUlid, shortUlid } from '@/lib/pg/ulid';
import type { OrgTx } from '@/lib/pg/with-tx';
import type {
  Contract,
  ContractEvent,
  ContractEventActor,
  ContractEventType,
  ContractFields,
  ContractRelationRef,
  ContractRelations,
  ContractStatus,
  SignatureField,
} from '@/lib/types';

// 合約與合約歷程的 repository（MIL-83）。形狀照 src/lib/properties/repository.ts：
// - 第一個參數是 withTx 給的 tx，型別 OrgTx。不傳 org_id：INSERT 取交易的 app.org_id，查詢靠 RLS 篩選。
//   別的組織的合約和不存在的合約沒有差別。
// - ID 由這裡用 newUlid() 產生。
// - 建立、複製、刪除在同一個交易寫稽核事件（appendAudit）。任何一步失敗，整筆回滾。
// - fields 與 signature_fields 是 jsonb，讀出來就是物件。

interface ContractRow {
  id: string;
  property_id: string | null;
  contract_type: ContractType;
  status: ContractStatus;
  fields: ContractFields;
  signature_fields: SignatureField[];
  declined_reason: string | null;
  derived_from: string | null;
  created_at: Date;
  updated_at: Date | null;
}

const COLUMNS =
  'id, property_id, contract_type, status, fields, signature_fields, declined_reason, derived_from, created_at, updated_at';

function toContract(row: ContractRow): Contract {
  // 欄位形狀由 contract_type 決定（MIL-73）。資料庫的 CHECK 與 createContract 保證兩者一致，
  // 欄位 contract_type 預設 'lease'，所以既有資料一律讀成租賃合約。
  return {
    id: row.id,
    property_id: row.property_id,
    contract_type: row.contract_type,
    status: row.status,
    // pg 與 PGlite 都會把 jsonb 轉成物件
    fields: row.fields,
    signature_fields: row.signature_fields,
    declined_reason: row.declined_reason,
    derived_from: row.derived_from,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at ? row.updated_at.toISOString() : null,
  } as Contract;
}

/** 新的在前。ULID 隨時間遞增，所以 id DESC 就是建立時間由新到舊。 */
export async function listContracts(tx: OrgTx): Promise<Contract[]> {
  const { rows } = await tx.query<ContractRow>(`SELECT ${COLUMNS} FROM org.contracts ORDER BY id DESC`);
  return rows.map(toContract);
}

/**
 * 讀一份合約，找不到（含別的組織的合約）回 null。
 * 之後要在同一個交易改它時，傳 lock 'update'，讀到的狀態才不會被別的交易搶先改掉。
 * 只要確保狀態在交易期間不變（例如複製來源），傳 'share'。
 */
export async function getContract(tx: OrgTx, id: string, lock?: 'update' | 'share'): Promise<Contract | null> {
  const suffix = lock === 'update' ? ' FOR UPDATE' : lock === 'share' ? ' FOR SHARE' : '';
  const { rows } = await tx.query<ContractRow>(`SELECT ${COLUMNS} FROM org.contracts WHERE id = $1${suffix}`, [id]);
  return rows[0] ? toContract(rows[0]) : null;
}

// --- 合約歷程（ADR-0007）---

export interface ContractEventInput {
  type: ContractEventType;
  actor: ContractEventActor;
  note?: string | null;
}

interface EventRow {
  id: string;
  contract_id: string;
  type: ContractEventType;
  actor: ContractEventActor;
  note: string | null;
  created_at: Date;
}

/**
 * 寫入一筆歷程事件。append-only：資料庫連 UPDATE、DELETE 權限都沒給 app_rw，
 * 這個模組也刻意不提供更新或刪除單筆事件的函式。
 */
export async function appendContractEvent(tx: OrgTx, contractId: string, event: ContractEventInput): Promise<void> {
  await tx.query(
    `INSERT INTO org.contract_events (id, org_id, contract_id, type, actor, note)
     VALUES ($1, current_setting('app.org_id', true), $2, $3, $4, $5)`,
    [newUlid(), contractId, event.type, event.actor, event.note ?? null],
  );
}

/** 依發生順序（ULID 單調遞增）。 */
export async function listContractEvents(tx: OrgTx, contractId: string): Promise<ContractEvent[]> {
  const { rows } = await tx.query<EventRow>(
    'SELECT id, contract_id, type, actor, note, created_at FROM org.contract_events WHERE contract_id = $1 ORDER BY id ASC',
    [contractId],
  );
  return rows.map((row) => ({ ...row, created_at: row.created_at.toISOString() }));
}

// --- 建立、編輯、複製、刪除 ---

export interface NewContract {
  property_id: string | null;
  fields: ContractFields;
  signature_fields?: SignatureField[];
  contract_type?: ContractType;
}

/**
 * 建立合約草稿，回傳合約 ID。合約、「建立」歷程事件與稽核事件在同一個交易（ADR-0007）。
 * property_id 必須是同組織的物件，否則複合外鍵 (org_id, property_id) 擋下，整筆回滾。
 */
export async function createContract(tx: OrgTx, values: NewContract): Promise<string> {
  const id = newUlid();
  const contractType = values.contract_type ?? 'lease';
  await tx.query(
    `INSERT INTO org.contracts (id, org_id, property_id, contract_type, fields, signature_fields)
     VALUES ($1, current_setting('app.org_id', true), $2, $3, $4::jsonb, $5::jsonb)`,
    [id, values.property_id, contractType, JSON.stringify(values.fields), JSON.stringify(values.signature_fields ?? [])],
  );
  await appendContractEvent(tx, id, { type: 'created', actor: 'landlord' });
  // payload 不放姓名、地址、租金：canonical 寫入後刪不掉（ADR-0019 決議 5）
  await appendAudit(tx, {
    action: 'contract.create',
    object: { type: 'contract', id },
    payload: { property_id: values.property_id, contract_type: contractType },
  });
  return id;
}

/**
 * 寫入草稿的欄位與簽署區域。只有草稿能寫，回傳有沒有寫到。
 * 呼叫端先用 getContract(tx, id, 'update') 鎖住並讀目前的值，再合併要改的部分。
 */
export async function saveDraft(
  tx: OrgTx,
  id: string,
  next: { fields: ContractFields; signature_fields: SignatureField[] },
): Promise<boolean> {
  const { rows } = await tx.query(
    `UPDATE org.contracts SET fields = $2::jsonb, signature_fields = $3::jsonb, updated_at = now()
      WHERE id = $1 AND status = 'draft' RETURNING id`,
    [id, JSON.stringify(next.fields), JSON.stringify(next.signature_fields)],
  );
  return rows.length > 0;
}

/**
 * 複製為新草稿，回傳新合約 ID。來源不存在（含別的組織的合約）回 null。
 * 新約記「建立」、來源記「被複製為新草稿」，與稽核事件同交易寫入。
 * 衍生關聯（derived_from 欄位加建立事件附註）只在撤回修約路徑記錄；
 * 拒簽後的複製是純省時便利，不記衍生關聯（ADR-0006）。
 */
export async function copyContractAsDraft(tx: OrgTx, sourceId: string): Promise<string | null> {
  const source = await getContract(tx, sourceId, 'share');
  if (!source) return null;

  const isAmendment = source.status === 'voided';
  const derivedFrom = isAmendment ? source.id : null;
  const id = newUlid();
  await tx.query(
    `INSERT INTO org.contracts (id, org_id, property_id, contract_type, fields, signature_fields, derived_from)
     VALUES ($1, current_setting('app.org_id', true), $2, $3, $4::jsonb, $5::jsonb, $6)`,
    [id, source.property_id, source.contract_type, JSON.stringify(source.fields), JSON.stringify(source.signature_fields), derivedFrom],
  );
  await appendContractEvent(tx, id, {
    type: 'created',
    actor: 'landlord',
    note: isAmendment ? `衍生自合約 #${shortUlid(source.id)}（撤回後修約）` : null,
  });
  await appendContractEvent(tx, source.id, {
    type: 'copied',
    actor: 'landlord',
    note: `複製為新草稿：合約 #${shortUlid(id)}`,
  });
  await appendAudit(tx, {
    action: 'contract.copy',
    object: { type: 'contract', id },
    payload: { source_id: source.id, derived: isAmendment },
  });
  return id;
}

export type DeleteDraftResult = 'deleted' | 'not_found' | 'not_draft';

/**
 * 刪除草稿合約。歷程隨合約走，由外鍵一起刪除（UI 沒有單獨刪事件的入口）。
 * 稽核事件記「刪除」，與刪除同交易。非草稿不得刪。
 */
export async function deleteDraftContract(tx: OrgTx, id: string): Promise<DeleteDraftResult> {
  const contract = await getContract(tx, id, 'update');
  if (!contract) return 'not_found';
  if (contract.status !== 'draft') return 'not_draft';
  await tx.query('DELETE FROM org.contracts WHERE id = $1', [id]);
  await appendAudit(tx, {
    action: 'contract.delete',
    object: { type: 'contract', id },
    payload: { property_id: contract.property_id },
  });
  return 'deleted';
}

/** 物件有沒有任何合約。刪除物件前檢查（ADR-0025 決議 14）；別的組織的合約不算。 */
export async function propertyHasContracts(tx: OrgTx, propertyId: string): Promise<boolean> {
  const { rows } = await tx.query('SELECT 1 FROM org.contracts WHERE property_id = $1 LIMIT 1', [propertyId]);
  return rows.length > 0;
}

// --- 狀態轉移 ---

export interface TransitionCommit {
  status: ContractStatus;
  event: ContractEventInput;
  declinedReason?: string | null;
}

/** 狀態轉移與歷程事件同一個交易寫入（ADR-0007）：任一失敗一起回滾。 */
export async function commitTransition(tx: OrgTx, contractId: string, commit: TransitionCommit): Promise<void> {
  const { rows } = await tx.query(
    `UPDATE org.contracts
        SET status = $2, declined_reason = COALESCE($3, declined_reason), updated_at = now()
      WHERE id = $1 RETURNING id`,
    [contractId, commit.status, commit.declinedReason ?? null],
  );
  if (rows.length === 0) throw new Error('合約不存在，無法轉移狀態');
  await appendContractEvent(tx, contractId, commit.event);
}

// --- 衍生關聯 ---

/**
 * 查一份合約的衍生鏈鄰居：前身是 derived_from 指向的合約，後繼是 derived_from 指向本約的合約們。
 * 只回編號與狀態，供詳情頁「關聯合約」分頁連結用。
 */
export async function getContractRelations(tx: OrgTx, contract: Pick<Contract, 'id' | 'derived_from'>): Promise<ContractRelations> {
  const predecessor = contract.derived_from
    ? ((await tx.query<ContractRelationRef>('SELECT id, status FROM org.contracts WHERE id = $1', [contract.derived_from])).rows[0] ?? null)
    : null;
  const { rows: successors } = await tx.query<ContractRelationRef>(
    'SELECT id, status FROM org.contracts WHERE derived_from = $1 ORDER BY id ASC',
    [contract.id],
  );
  return { derived_from: predecessor, derived_contracts: successors };
}

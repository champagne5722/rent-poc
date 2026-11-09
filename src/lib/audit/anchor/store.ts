import type { ControlTx, OrgTx } from '../../pg/with-tx';
import type { MerkleLeaf, MerkleProofStep } from './merkle';

// 錨定的資料庫存取（MIL-88，ADR-0019 決議 8、13）。讀鏈頭與寫錨定的函式各只呼叫一個定義者函式，不直接碰 audit 的表。
// 例外是 listChainIds，它讀組織目錄 control.orgs（app_rw 有 SELECT）。
// 函式只回傳雜湊、證明與回執，不回傳事件內容。
//
// 介面的規則：
// - listUnanchoredHeads、recordAnchor、recordAnchorFailure 不需要組織脈絡，用 control 交易。
// - listChainAnchors 只讀 app.org_id 那條鏈，用 org 交易。逐組織驗證，不需要跨組織的讀取權限。
// - 呼叫外部服務不得在這些交易內（withTx 規則 2）：先讀鏈頭，交易結束，呼叫服務，再開交易保存。

export interface AnchorHead {
  chainId: string;
  seq: number;
  headHash: string;
}

export interface RecordAnchorInput {
  at: Date;
  provider: string;
  root: string;
  receipt: string;
  issuedAt: Date;
  leaves: readonly MerkleLeaf[];
}

export interface ChainAnchor {
  batchId: number;
  anchoredAt: Date;
  provider: string;
  root: string;
  receipt: string;
  issuedAt: Date;
  seq: number;
  headHash: string;
  proof: MerkleProofStep[];
}

/** record_anchor 發現這片葉的序號已被較新的錨定涵蓋時的 SQLSTATE。兩個排程同時執行時，後到的拿到它。 */
export const SQLSTATE_SUPERSEDED = 'AU001';

export const isSupersededError = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === SQLSTATE_SUPERSEDED;

const safeSeq = (value: string | number): number => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`稽核序號超出安全整數範圍：${String(value)}`);
  return n;
};

export async function listUnanchoredHeads(tx: ControlTx): Promise<AnchorHead[]> {
  const { rows } = await tx.query<{ chain_id: string; seq: string; hash: string }>(
    'SELECT chain_id, seq::text AS seq, hash FROM audit.unanchored_heads()',
  );
  return rows.map((r) => ({ chainId: r.chain_id, seq: safeSeq(r.seq), headHash: r.hash }));
}

/** 保存一次成功的錨定，回傳批次編號。已被較新的錨定涵蓋時丟出 `isSupersededError` 為真的錯。 */
export async function recordAnchor(tx: ControlTx, input: RecordAnchorInput): Promise<number> {
  const leaves = input.leaves.map((l) => ({ chain: l.leaf.chainId, seq: l.leaf.seq, hash: l.leaf.headHash, proof: l.proof }));
  const { rows } = await tx.query<{ batch: string }>(
    'SELECT audit.record_anchor($1::timestamptz, $2, $3, $4, $5::timestamptz, $6::jsonb)::text AS batch',
    [input.at.toISOString(), input.provider, input.root, input.receipt, input.issuedAt.toISOString(), JSON.stringify(leaves)],
  );
  return safeSeq(rows[0].batch);
}

/** 記一次失敗，回傳目前連續失敗的次數。 */
export async function recordAnchorFailure(tx: ControlTx, at: Date, error: string): Promise<number> {
  const { rows } = await tx.query<{ n: number }>('SELECT audit.record_anchor_failure($1::timestamptz, $2) AS n', [at.toISOString(), error]);
  return Number(rows[0].n);
}

interface AnchorRow {
  batch_id: string;
  anchored_at: Date | string;
  provider: string;
  root: string;
  receipt: string;
  issued_at: Date | string;
  seq: string;
  head_hash: string;
  proof: MerkleProofStep[] | string;
}

export async function listChainAnchors(tx: OrgTx): Promise<ChainAnchor[]> {
  const { rows } = await tx.query<AnchorRow>(
    `SELECT batch_id::text AS batch_id, anchored_at, provider, root, receipt, issued_at, seq::text AS seq, head_hash, proof
       FROM audit.chain_anchors()`,
  );
  return rows.map((r) => ({
    batchId: safeSeq(r.batch_id),
    anchoredAt: new Date(r.anchored_at),
    provider: r.provider,
    root: r.root,
    receipt: r.receipt,
    issuedAt: new Date(r.issued_at),
    seq: safeSeq(r.seq),
    headHash: r.head_hash,
    proof: typeof r.proof === 'string' ? (JSON.parse(r.proof) as MerkleProofStep[]) : r.proof,
  }));
}

/** 所有鏈的編號，含平台組織：平台鏈也要驗。組織目錄在 control，不需要組織脈絡。 */
export async function listChainIds(tx: ControlTx): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>('SELECT id FROM control.orgs ORDER BY id');
  return rows.map((r) => r.id);
}

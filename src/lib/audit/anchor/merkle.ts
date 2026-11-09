import { createHash } from 'node:crypto';
import { ROOT_PATTERN as HEX64 } from './provider';

// 稽核鏈錨定用的 Merkle 計算（ADR-0019 決議 8，MIL-88）。純函式，不讀時鐘、不碰資料庫。
//
// 介面的規則：
// - 葉是「鏈、序號、鏈頭雜湊」。一批錨定每條鏈只有一片葉，建樹前依鏈排序。
// - 葉雜湊 = sha256(0x00 || utf8("鏈:序號:鏈頭雜湊"))，節點 = sha256(0x01 || 左 || 右)。
//   前置位元組區分葉與節點，避免把節點當成葉的第二原像攻擊。
// - 一層的節點數是奇數時，最後一個節點直接上移，不複製。複製會讓兩種不同的葉集合得到同一個樹根。
// - 每片葉附一條證明。單一組織只拿自己的葉與證明，就能推回樹根，不需要看到別人的葉（ADR-0019 決議 8）。

export interface AnchorLeaf {
  chainId: string;
  seq: number;
  /** 64 位小寫十六進位。 */
  headHash: string;
}

export interface MerkleProofStep {
  /** 兄弟節點在哪一側。 */
  side: 'left' | 'right';
  hash: string;
}

export interface MerkleLeaf {
  leaf: AnchorLeaf;
  leafHash: string;
  proof: MerkleProofStep[];
}

export interface MerkleTree {
  /** 64 位小寫十六進位。送出去錨定的就是這個值。 */
  root: string;
  /** 依鏈排序後的葉，每片附證明。 */
  leaves: MerkleLeaf[];
}

const sha256 = (...parts: Buffer[]) => createHash('sha256').update(Buffer.concat(parts)).digest();
const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

function assertLeaf(leaf: AnchorLeaf): void {
  if (!Number.isSafeInteger(leaf.seq) || leaf.seq < 1) throw new Error(`葉的序號必須是正整數：${String(leaf.seq)}`);
  if (!HEX64.test(leaf.headHash)) throw new Error('葉的鏈頭雜湊必須是 64 位小寫十六進位');
  if (typeof leaf.chainId !== 'string' || leaf.chainId === '') throw new Error('葉的鏈不得為空');
}

function leafBytes(leaf: AnchorLeaf): Buffer {
  assertLeaf(leaf);
  return sha256(LEAF_PREFIX, Buffer.from(`${leaf.chainId}:${leaf.seq}:${leaf.headHash}`, 'utf8'));
}

export function leafHash(leaf: AnchorLeaf): string {
  return leafBytes(leaf).toString('hex');
}

const byChain = (a: AnchorLeaf, b: AnchorLeaf) => (a.chainId < b.chainId ? -1 : a.chainId > b.chainId ? 1 : 0);

export function buildMerkleTree(input: readonly AnchorLeaf[]): MerkleTree {
  if (input.length === 0) throw new Error('Merkle 樹至少一片葉');
  const sorted = [...input].sort(byChain);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].chainId === sorted[i - 1].chainId) throw new Error(`同一批葉的鏈重複：${sorted[i].chainId}`);
  }

  const leaves: MerkleLeaf[] = sorted.map((leaf) => ({ leaf, leafHash: leafHash(leaf), proof: [] }));
  // level 的每個元素記錄節點雜湊，以及它底下有哪些葉（寫證明時要補上兄弟節點）
  let level = leaves.map((l, index) => ({ hash: Buffer.from(l.leafHash, 'hex'), members: [index] }));
  while (level.length > 1) {
    const next: typeof level = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1];
      if (!right) {
        next.push(left); // 奇數節點直接上移
        continue;
      }
      for (const m of left.members) leaves[m].proof.push({ side: 'right', hash: right.hash.toString('hex') });
      for (const m of right.members) leaves[m].proof.push({ side: 'left', hash: left.hash.toString('hex') });
      next.push({ hash: sha256(NODE_PREFIX, left.hash, right.hash), members: [...left.members, ...right.members] });
    }
    level = next;
  }
  return { root: level[0].hash.toString('hex'), leaves };
}

/** 葉與證明能推回樹根時回傳 true。任何格式不合的輸入都回傳 false，不丟錯。 */
export function verifyMerkleProof(leaf: AnchorLeaf, proof: readonly MerkleProofStep[], root: string): boolean {
  try {
    let current = leafBytes(leaf);
    for (const step of proof) {
      if (!HEX64.test(step.hash) || (step.side !== 'left' && step.side !== 'right')) return false;
      const sibling = Buffer.from(step.hash, 'hex');
      current = step.side === 'left' ? sha256(NODE_PREFIX, sibling, current) : sha256(NODE_PREFIX, current, sibling);
    }
    return current.toString('hex') === root;
  } catch {
    return false;
  }
}

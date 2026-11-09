import { describe, expect, it } from 'vitest';
import { buildMerkleTree, leafHash, verifyMerkleProof, type AnchorLeaf } from './merkle';

// Merkle 計算（ADR-0019 決議 8，MIL-88）。期望值由獨立腳本用 node:crypto 直接算出，不經過被測程式。
// 葉雜湊 = sha256(0x00 || "鏈:序號:鏈頭雜湊")，節點 = sha256(0x01 || 左 || 右)，奇數節點直接上移。

const PLATFORM = '00000000000000000000000001';
const A = '01JBKQ0000000000000000000A';
const B = '01JBKQ0000000000000000000B';
const leafA: AnchorLeaf = { chainId: A, seq: 3, headHash: 'a'.repeat(64) };
const leafB: AnchorLeaf = { chainId: B, seq: 7, headHash: 'b'.repeat(64) };
const leafP: AnchorLeaf = { chainId: PLATFORM, seq: 1, headHash: 'c'.repeat(64) };

const HASH_A = '6372fd8017d79479bf568ccf1a6195bbca1db2d578b8d68b25e6ca68ebcf6ebc';
const HASH_B = 'f411b849d62b0fe4d66d7c1b9b90d061ba911a284641a7091d5ee7d765639ad0';
const HASH_P = '8830937137bc7ad427ddf7f80850cae620f935bae937d0ec7a2afcc525249a84';
const HASH_PA = 'de6878958e34251886ecd6d43a32eae4ffae05cecbfcb466b5761d2617f0814a';
const ROOT_AB = '521e1fdb035b141cd547431af299dc45443da2667003d9affe63361fee523f20';
const ROOT_PAB = 'a18085a625c0eddfd87d3b0105d84396783e6a1b73d5ca6bee6e9cbd3d6a2692';

describe('leafHash', () => {
  it('對應已知的雜湊值', () => {
    expect(leafHash(leafA)).toBe(HASH_A);
    expect(leafHash(leafB)).toBe(HASH_B);
  });

  it('鏈、序號、鏈頭雜湊任何一個不同，雜湊都不同', () => {
    expect(leafHash({ ...leafA, seq: 4 })).not.toBe(HASH_A);
    expect(leafHash({ ...leafA, chainId: B })).not.toBe(HASH_A);
    expect(leafHash({ ...leafA, headHash: 'd'.repeat(64) })).not.toBe(HASH_A);
  });
});

describe('buildMerkleTree', () => {
  it('一片葉的樹根就是葉雜湊，證明是空的', () => {
    const tree = buildMerkleTree([leafA]);
    expect(tree.root).toBe(HASH_A);
    expect(tree.leaves).toEqual([{ leaf: leafA, leafHash: HASH_A, proof: [] }]);
  });

  it('兩片葉：樹根是 sha256(0x01 || 左 || 右)', () => {
    expect(buildMerkleTree([leafA, leafB]).root).toBe(ROOT_AB);
  });

  it('三片葉：奇數的那片直接上移，不複製', () => {
    expect(buildMerkleTree([leafP, leafA, leafB]).root).toBe(ROOT_PAB);
  });

  it('輸入順序不影響結果：葉依鏈排序後組樹', () => {
    const sorted = buildMerkleTree([leafP, leafA, leafB]);
    const shuffled = buildMerkleTree([leafB, leafP, leafA]);
    expect(shuffled.root).toBe(sorted.root);
    expect(shuffled.leaves.map((l) => l.leaf.chainId)).toEqual([PLATFORM, A, B]);
  });

  it('不改動傳入的陣列', () => {
    const input = [leafB, leafA];
    buildMerkleTree(input);
    expect(input).toEqual([leafB, leafA]);
  });

  it('任何一片葉改動，樹根就不同', () => {
    const base = buildMerkleTree([leafA, leafB]).root;
    expect(buildMerkleTree([{ ...leafA, seq: 4 }, leafB]).root).not.toBe(base);
    expect(buildMerkleTree([leafA, { ...leafB, headHash: 'e'.repeat(64) }]).root).not.toBe(base);
  });

  it('證明的內容：兄弟節點與所在的一側', () => {
    const tree = buildMerkleTree([leafP, leafA, leafB]);
    const [p, a, b] = tree.leaves;
    expect(p.proof).toEqual([
      { side: 'right', hash: HASH_A },
      { side: 'right', hash: HASH_B },
    ]);
    expect(a.proof).toEqual([
      { side: 'left', hash: HASH_P },
      { side: 'right', hash: HASH_B },
    ]);
    // B 在最後一層沒有兄弟，直接上移，只和 P、A 合成的節點合併
    expect(b.proof).toEqual([{ side: 'left', hash: HASH_PA }]);
  });

  it('空陣列丟錯：沒有葉就不該錨定', () => {
    expect(() => buildMerkleTree([])).toThrow(/至少一片葉/);
  });

  it('同一條鏈出現兩次丟錯：一批錨定每條鏈只有一片葉', () => {
    expect(() => buildMerkleTree([leafA, { ...leafA, seq: 9 }])).toThrow(/重複/);
  });

  it('鏈頭雜湊不是 64 位小寫十六進位丟錯', () => {
    expect(() => buildMerkleTree([{ ...leafA, headHash: 'xyz' }])).toThrow(/鏈頭雜湊/);
    expect(() => buildMerkleTree([{ ...leafA, headHash: 'A'.repeat(64) }])).toThrow(/鏈頭雜湊/);
  });

  it('序號不是正整數丟錯', () => {
    expect(() => buildMerkleTree([{ ...leafA, seq: 0 }])).toThrow(/序號/);
    expect(() => buildMerkleTree([{ ...leafA, seq: 1.5 }])).toThrow(/序號/);
  });
});

describe('verifyMerkleProof', () => {
  const tree = buildMerkleTree([leafP, leafA, leafB]);

  it('每一片葉的證明都能推回樹根', () => {
    for (const { leaf, proof } of tree.leaves) expect(verifyMerkleProof(leaf, proof, tree.root)).toBe(true);
  });

  it('葉被改過，證明失敗', () => {
    const { proof } = tree.leaves[1];
    expect(verifyMerkleProof({ ...leafA, headHash: 'f'.repeat(64) }, proof, tree.root)).toBe(false);
    expect(verifyMerkleProof({ ...leafA, seq: 99 }, proof, tree.root)).toBe(false);
  });

  it('證明被改過或樹根不同，證明失敗', () => {
    const { proof } = tree.leaves[1];
    expect(verifyMerkleProof(leafA, [{ ...proof[0], side: 'right' }, proof[1]], tree.root)).toBe(false);
    expect(verifyMerkleProof(leafA, proof.slice(1), tree.root)).toBe(false);
    expect(verifyMerkleProof(leafA, proof, ROOT_AB)).toBe(false);
  });

  it('格式不合的輸入回傳 false，不丟錯', () => {
    expect(verifyMerkleProof(leafA, [{ side: 'left', hash: 'zz' }], tree.root)).toBe(false);
    expect(verifyMerkleProof({ ...leafA, headHash: 'zz' }, [], tree.root)).toBe(false);
  });
});

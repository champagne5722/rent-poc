import { describe, expect, it } from 'vitest';
import { defaultFieldRect, overlapWarning, rectsOverlap } from './signature-layout';
import { PAGE_H } from './pdf-layout';
import type { SignatureBlockSeat } from './pdf-layout';
import type { SignatureField } from './types';

// 簽署序列（簽署順序）：乙方、執業人員、甲方。印列順序仍是甲方、乙方、執業人員。
const THREE: SignatureBlockSeat[] = [
  { role: 'party_b', slot: 'b' },
  { role: 'practitioner', slot: 'p' },
  { role: 'party_a', slot: 'a' },
];
const FOUR: SignatureBlockSeat[] = [...THREE, { role: 'practitioner', slot: 'broker' }];

const ROW_STEP = 102 / PAGE_H; // 每個簽署欄的高度（比例）

function rectFor(signer: SignatureField['signer'], seats: SignatureBlockSeat[], page: number, signaturePage: number, slot?: string) {
  return defaultFieldRect({ signer, slot, page, signaturePage, existing: [], seats });
}

describe('defaultFieldRect 依簽署席位落點', () => {
  it('簽名頁：執業人員框落在乙方框下方一個簽署欄', () => {
    const partyB = rectFor('party_b', THREE, 1, 1, 'b');
    const practitioner = rectFor('practitioner', THREE, 1, 1, 'p');
    expect(practitioner.y - partyB.y).toBeCloseTo(ROW_STEP, 6);
    expect(practitioner.x).toBeCloseTo(partyB.x, 10);
  });

  it('三位的甲方與乙方落點與兩方合約相同', () => {
    const twoPartyA = defaultFieldRect({ signer: 'party_a', page: 1, signaturePage: 1, existing: [] });
    const twoPartyB = defaultFieldRect({ signer: 'party_b', page: 1, signaturePage: 1, existing: [] });
    expect(rectFor('party_a', THREE, 1, 1, 'a')).toEqual(twoPartyA);
    expect(rectFor('party_b', THREE, 1, 1, 'b')).toEqual(twoPartyB);
  });

  it('同角色的兩個席位靠 slot 落在不同的簽署欄', () => {
    const manager = rectFor('practitioner', FOUR, 1, 1, 'p');
    const broker = rectFor('practitioner', FOUR, 1, 1, 'broker');
    expect(broker.y - manager.y).toBeCloseTo(ROW_STEP, 6);
  });

  it('沒有 slot 的舊資料對應該角色的第一個席位', () => {
    expect(rectFor('practitioner', FOUR, 1, 1)).toEqual(rectFor('practitioner', FOUR, 1, 1, 'p'));
  });

  it('非簽名頁：三個席位都在頁內，彼此不重疊，由上而下是甲、乙、執業人員', () => {
    const a = rectFor('party_a', THREE, 0, 2, 'a');
    const b = rectFor('party_b', THREE, 0, 2, 'b');
    const p = rectFor('practitioner', THREE, 0, 2, 'p');
    for (const rect of [a, b, p]) {
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.y + rect.h).toBeLessThanOrEqual(1);
    }
    expect(a.y).toBeLessThan(b.y);
    expect(b.y).toBeLessThan(p.y);
    expect(rectsOverlap(a, b) || rectsOverlap(b, p) || rectsOverlap(a, p)).toBe(false);
  });

  it('非簽名頁的兩方落點不因為支援 N 列而改變', () => {
    const partyAOnly = defaultFieldRect({ signer: 'party_a', page: 0, signaturePage: 2, existing: [] });
    const partyA = rectFor('party_a', [{ role: 'party_b' }, { role: 'party_a' }], 0, 2);
    expect(partyA).toEqual(partyAOnly);
  });
});

describe('重疊警示認得簽署席位', () => {
  const field = (id: string, signer: SignatureField['signer'], slot?: string): SignatureField => ({
    id,
    signer,
    ...(slot ? { slot } : {}),
    page: 0,
    x: 0.2,
    y: 0.2,
    w: 0.3,
    h: 0.06,
  });

  it('管理人員與經紀人的簽名框重疊要警示，字樣不寫甲乙', () => {
    expect(overlapWarning([field('1', 'practitioner', 'p'), field('2', 'practitioner', 'broker')])).toBe(
      '第 1 頁有不同簽署席位的簽名框重疊，請分開擺放避免簽名蓋到彼此',
    );
  });

  it('同一席位的框重疊不警示', () => {
    expect(overlapWarning([field('1', 'practitioner', 'p'), field('2', 'practitioner', 'p')])).toBeNull();
  });

  it('甲方與執業人員重疊要警示', () => {
    expect(overlapWarning([field('1', 'party_a', 'a'), field('2', 'practitioner', 'p')])).toContain('重疊');
  });

  it('舊資料（沒有 slot）與新增的同角色框不算不同席位', () => {
    expect(overlapWarning([field('1', 'party_a'), field('2', 'party_a', 'lease.self_managed.party_a')])).toBeNull();
  });

  it('甲乙重疊的警示字樣不變', () => {
    expect(overlapWarning([field('1', 'party_a'), field('2', 'party_b')])).toBe(
      '第 1 頁有甲乙簽名框重疊，請分開擺放避免簽名蓋到彼此',
    );
  });
});

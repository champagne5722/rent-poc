import { describe, expect, it } from 'vitest';
import { MARGIN, PAGE_H, PAGE_W, statusAnnexStampBaseline, type SignatureBlockSeat } from './pdf-layout';
import { defaultFieldRect } from './signature-layout';

// 簽名框的預設落點在有附件頁的合約（MIL-162、MIL-71）：
// 簽名頁由 PDF 版面判定，不是最後一頁；現況確認附件頁的執業人員框落在頁底的固定位置。

const SEATS: SignatureBlockSeat[] = [
  { role: 'party_b', slot: 'b' },
  { role: 'practitioner', slot: 'p' },
  { role: 'party_a', slot: 'a' },
  { role: 'practitioner', slot: 'broker' },
];
const ANNEX = { page: 3, slots: ['p'] };

function rect(slot: string, page: number, signaturePage: number, statusAnnex?: { page: number; slots: readonly string[] }) {
  const seat = SEATS.find((s) => s.slot === slot)!;
  return defaultFieldRect({ signer: seat.role, slot, page, signaturePage, existing: [], seats: SEATS, statusAnnex });
}

describe('MIL-162：簽名頁不是最後一頁時，預設落點仍在簽署欄旁', () => {
  it('簽名頁在第 2 頁（共 4 頁）時，簽名頁上的框落點與「簽名頁就是最後一頁」時相同', () => {
    const lastPageCase = rect('p', 1, 1);
    // 簽名頁碼由呼叫端傳入；落點只看「是不是簽名頁」，所以頁碼不同、版面相同
    expect(rect('p', 2, 2)).toEqual(lastPageCase);
  });

  it('不在簽名頁的框用備援落點，不用簽署欄的位置', () => {
    const onSignature = rect('p', 1, 1);
    const onOtherPage = rect('p', 3, 1);
    expect(onOtherPage).not.toEqual(onSignature);
    // 備援落點靠右下
    expect(onOtherPage.x).toBeGreaterThan(onSignature.x);
  });
});

describe('現況確認附件頁的預設落點', () => {
  it('執業人員框落在附件頁頁底「簽章：」旁', () => {
    const r = rect('p', 3, 1, ANNEX);
    const baseline = statusAnnexStampBaseline();
    // 框頂在「簽章：」baseline 上方約一個字高，左緣在「簽章：」之後
    expect(r.y).toBeCloseTo((PAGE_H - (baseline + 11)) / PAGE_H, 6);
    expect(r.x).toBeCloseTo((MARGIN + 33 + 8) / PAGE_W, 6);
    expect(r.y + r.h).toBeLessThan(1);
    expect(r.x + r.w).toBeLessThanOrEqual(1);
  });

  it('只有規則列指定的席位落在附件頁的簽署欄，其他席位用備援落點', () => {
    const manager = rect('p', 3, 1, ANNEX);
    const broker = rect('broker', 3, 1, ANNEX);
    const partyA = rect('a', 3, 1, ANNEX);
    expect(broker).not.toEqual(manager);
    expect(partyA).not.toEqual(manager);
  });

  it('附件頁以外的頁面，執業人員框落點不受影響', () => {
    expect(rect('p', 1, 1, ANNEX)).toEqual(rect('p', 1, 1));
    expect(rect('p', 0, 1, ANNEX)).toEqual(rect('p', 0, 1));
  });

  it('沒有附件頁時行為不變', () => {
    expect(rect('p', 3, 1, undefined)).toEqual(rect('p', 3, 1));
  });

  it('附件頁上已有框時往右下錯開，不蓋住舊框', () => {
    const first = rect('p', 3, 1, ANNEX);
    const seat = SEATS[1];
    const second = defaultFieldRect({
      signer: seat.role,
      slot: 'p',
      page: 3,
      signaturePage: 1,
      existing: [{ id: 'x', signer: 'practitioner', slot: 'p', page: 3, ...first }],
      seats: SEATS,
      statusAnnex: ANNEX,
    });
    expect(second.x).toBeGreaterThan(first.x);
    expect(second.y).toBeGreaterThan(first.y);
  });
});

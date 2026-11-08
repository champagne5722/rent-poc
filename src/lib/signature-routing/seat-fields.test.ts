import { describe, expect, it } from 'vitest';
import type { SignatureField } from '../types';
import { evaluateRouting } from './seats';
import { countFieldsBySeat, reconcileSignatureFields, seatOfField } from './seat-fields';

const field = (id: string, signer: SignatureField['signer'], slot?: string): SignatureField => ({
  id,
  signer,
  ...(slot ? { slot } : {}),
  page: 0,
  x: 0.1,
  y: 0.1,
  w: 0.2,
  h: 0.05,
});

function seatsFor(conditions: unknown) {
  const result = evaluateRouting(conditions);
  if (!result.ok) throw new Error(result.reason);
  return result.seats;
}

const SELF = seatsFor(undefined);
const MASTER = seatsFor({ businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: false });
const MASTER_BROKER = seatsFor({ businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: true });

describe('seatOfField（簽署區域屬於哪個簽署席位）', () => {
  it('有 slot 的歸該席位', () => {
    const broker = MASTER_BROKER[3];
    expect(seatOfField(field('f', 'practitioner', broker.ruleId), MASTER_BROKER)?.ruleId).toBe(broker.ruleId);
  });

  it('舊資料沒有 slot，以簽署角色對應該角色的第一個席位', () => {
    expect(seatOfField(field('f', 'party_a'), SELF)?.role).toBe('party_a');
    expect(seatOfField(field('f', 'practitioner'), MASTER_BROKER)?.ruleId).toBe(MASTER_BROKER[1].ruleId);
  });

  it('slot 不在目前的序列內時不對應任何席位，不退回角色', () => {
    expect(seatOfField(field('f', 'party_a', 'lease.master_lease.party_a'), SELF)).toBeUndefined();
  });

  it('序列沒有這個角色時不對應', () => {
    expect(seatOfField(field('f', 'practitioner'), SELF)).toBeUndefined();
  });
});

describe('countFieldsBySeat（每個簽署席位的簽署區域數）', () => {
  it('依簽署序列列出每個席位，沒有區域的席位數量為 0', () => {
    const counts = countFieldsBySeat([field('1', 'party_b', SELF[0].ruleId)], SELF);
    expect(counts.map((c) => [c.seat.role, c.count])).toEqual([
      ['party_b', 1],
      ['party_a', 0],
    ]);
  });

  it('同角色兩個席位各自計數', () => {
    const counts = countFieldsBySeat(
      [
        field('1', 'practitioner', MASTER_BROKER[1].ruleId),
        field('2', 'practitioner', MASTER_BROKER[3].ruleId),
        field('3', 'practitioner', MASTER_BROKER[3].ruleId),
      ],
      MASTER_BROKER,
    );
    expect(counts.map((c) => c.count)).toEqual([0, 1, 0, 2]);
  });

  it('舊資料（沒有 slot）照角色計入第一個席位', () => {
    const counts = countFieldsBySeat([field('1', 'party_a'), field('2', 'party_b')], SELF);
    expect(counts.map((c) => c.count)).toEqual([1, 1]);
  });
});

describe('reconcileSignatureFields（分流條件改變後整理簽署區域）', () => {
  it('slot 仍在序列內的原樣保留', () => {
    const fields = [field('1', 'party_b', SELF[0].ruleId)];
    expect(reconcileSignatureFields(fields, SELF)).toEqual({ fields, removed: 0 });
  });

  it('舊資料沒有 slot 且角色仍在序列內，保持原樣，不補 slot', () => {
    const fields = [field('1', 'party_a'), field('2', 'party_b')];
    expect(reconcileSignatureFields(fields, MASTER)).toEqual({ fields, removed: 0 });
  });

  it('slot 已不在序列內但角色還在：改歸該角色的第一個席位，座標不動', () => {
    const stale = field('1', 'party_a', 'lease.self_managed.party_a');
    const { fields, removed } = reconcileSignatureFields([stale], MASTER);
    expect(removed).toBe(0);
    expect(fields[0]).toEqual({ ...stale, slot: MASTER[2].ruleId });
  });

  it('序列已沒有這個角色：移除該簽署區域並回報數量', () => {
    const practitioner = field('1', 'practitioner', MASTER[1].ruleId);
    const partyA = field('2', 'party_a', MASTER[2].ruleId);
    const result = reconcileSignatureFields([practitioner, partyA], SELF);
    expect(result.removed).toBe(1);
    expect(result.fields.map((f) => f.id)).toEqual(['2']);
    expect(result.fields[0].slot).toBe(SELF[1].ruleId);
  });

  it('沒有 slot 的執業人員區域在序列沒有執業人員時移除', () => {
    const result = reconcileSignatureFields([field('1', 'practitioner')], SELF);
    expect(result).toEqual({ fields: [], removed: 1 });
  });
});

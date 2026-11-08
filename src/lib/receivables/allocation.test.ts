import { describe, expect, it } from 'vitest';
import { allocateReceipt, applyPrepaid, reallocate } from './allocation';
import { allocatedAmount, periodStatus } from './status';
import type { Allocation, AllocationDraft, ReceivablePeriod } from './types';

function mk(id: string, key: string, over: Partial<ReceivablePeriod> = {}): ReceivablePeriod {
  return {
    id,
    periodKey: key,
    periodStart: `${key}-01`,
    periodEnd: `${key}-28`,
    dueDate: `${key}-05`,
    amount: 10000,
    kind: 'rent',
    state: 'active',
    ...over,
  };
}

// 刻意打亂順序，驗證預設依到期日由舊到新。
const P1 = mk('p1', '2026-01');
const P2 = mk('p2', '2026-02');
const P3 = mk('p3', '2026-03');
const PERIODS = [P3, P1, P2];

let seq = 0;
function stored(draft: AllocationDraft, active = true): Allocation {
  seq += 1;
  return { ...draft, id: `a${seq}`, active };
}
function existing(periodId: string, amount: number, over: Partial<Allocation> = {}): Allocation {
  seq += 1;
  return { id: `a${seq}`, sourceId: 'old', periodId, amount, source: 'receipt', kind: 'rent', active: true, ...over };
}

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`預期成功，實際失敗：${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

describe('allocateReceipt（預設配給最舊的未足額期別）', () => {
  const run = (amount: number, allocations: Allocation[] = [], periodOrder?: string[]) =>
    allocateReceipt(PERIODS, amount, { receiptId: 'r1', allocations, periodOrder });

  it('一筆付多期：25000 元依序配 p1 10000、p2 10000、p3 5000', () => {
    const r = ok(run(25000));
    expect(r.allocations.map((a) => [a.periodId, a.amount])).toEqual([
      ['p1', 10000],
      ['p2', 10000],
      ['p3', 5000],
    ]);
    expect(r.prepaid).toBe(0);
    expect(r.allocations.every((a) => a.sourceId === 'r1' && a.source === 'receipt' && a.kind === 'rent')).toBe(true);
  });

  it('部分入帳：6000 元只配到 p1', () => {
    const r = ok(run(6000));
    expect(r.allocations).toEqual([{ sourceId: 'r1', periodId: 'p1', amount: 6000, source: 'receipt', kind: 'rent' }]);
    expect(r.prepaid).toBe(0);
  });

  it('從上次未補足的部分接著配：p1 已入 6000，再入 7000 → p1 補 4000、p2 配 3000', () => {
    const r = ok(run(7000, [existing('p1', 6000)]));
    expect(r.allocations.map((a) => [a.periodId, a.amount])).toEqual([
      ['p1', 4000],
      ['p2', 3000],
    ]);
  });

  it('恰好付清全部未足額期別：沒有預收', () => {
    const r = ok(run(30000));
    expect(r.allocations.map((a) => a.amount)).toEqual([10000, 10000, 10000]);
    expect(r.prepaid).toBe(0);
  });

  it('超額轉預收：35000 元配滿三期，剩 5000 為預收', () => {
    const r = ok(run(35000));
    expect(r.allocations.reduce((s, a) => s + a.amount, 0)).toBe(30000);
    expect(r.prepaid).toBe(5000);
  });

  it('全部已足額：不產生配置，整筆是預收', () => {
    const full = [existing('p1', 10000), existing('p2', 10000), existing('p3', 10000)];
    const r = ok(run(8000, full));
    expect(r.allocations).toEqual([]);
    expect(r.prepaid).toBe(8000);
  });

  it('失效的配置不算已入帳：p1 的舊配置失效，p1 仍是最舊的未足額期別', () => {
    const r = ok(run(4000, [existing('p1', 10000, { active: false })]));
    expect(r.allocations.map((a) => [a.periodId, a.amount])).toEqual([['p1', 4000]]);
  });

  it('跳過已取消的期別', () => {
    const r = allocateReceipt(
      [P1, mk('p2', '2026-02', { state: 'cancelled' }), P3],
      15000,
      { receiptId: 'r1', allocations: [] },
    );
    expect(ok(r).allocations.map((a) => [a.periodId, a.amount])).toEqual([
      ['p1', 10000],
      ['p3', 5000],
    ]);
  });

  it('使用者指定順序：先配 p3，再依預設順序補 p1', () => {
    const r = ok(run(15000, [], ['p3']));
    expect(r.allocations.map((a) => [a.periodId, a.amount])).toEqual([
      ['p3', 10000],
      ['p1', 5000],
    ]);
  });

  it('到期日相同時依期別鍵排序，結果固定', () => {
    const a = mk('pa', '2026-02', { dueDate: '2026-02-05' });
    const b = mk('pb', '2026-01', { dueDate: '2026-02-05' });
    const r = allocateReceipt([a, b], 1000, { receiptId: 'r1', allocations: [] });
    expect(ok(r).allocations[0].periodId).toBe('pb');
  });

  describe('拒絕不合法的輸入', () => {
    it.each([
      ['0 元', 0],
      ['負數', -100],
      ['小數', 100.5],
      ['超過安全整數', Number.MAX_SAFE_INTEGER + 1],
      ['NaN', Number.NaN],
    ])('金額 %s → invalid_amount', (_name, amount) => {
      expect(run(amount)).toEqual({ ok: false, reason: 'invalid_amount' });
    });

    it('指定順序含不存在的期別 → unknown_period', () => {
      expect(run(1000, [], ['nope'])).toEqual({ ok: false, reason: 'unknown_period' });
    });

    it('押金期別不得進入租金配置：執行時也擋 → wrong_kind', () => {
      const bad = { ...P1, kind: 'deposit' } as unknown as ReceivablePeriod;
      expect(allocateReceipt([bad], 1000, { receiptId: 'r1', allocations: [] })).toEqual({
        ok: false,
        reason: 'wrong_kind',
      });
    });
  });

  it('押金與租金在型別上分開：押金期別編譯不過', () => {
    // 下面這行如果能編譯，@ts-expect-error 會讓 tsc 失敗。
    // @ts-expect-error 押金不是租金期別
    const depositPeriod: ReceivablePeriod = { ...P1, kind: 'deposit' };
    expect(depositPeriod.kind).toBe('deposit');
  });
});

describe('applyPrepaid（預收抵充）', () => {
  const opts = (allocations: Allocation[] = []) => ({ applicationId: 'ap1', allocations });

  it('抵充整期未足額金額', () => {
    const r = ok(applyPrepaid(P1, 50000, 10000, opts()));
    expect(r.allocation).toEqual({ sourceId: 'ap1', periodId: 'p1', amount: 10000, source: 'prepaid', kind: 'rent' });
    expect(r.remainingPrepaid).toBe(40000);
  });

  it('抵充部分金額', () => {
    const r = ok(applyPrepaid(P1, 50000, 3000, opts()));
    expect(r.allocation.amount).toBe(3000);
    expect(r.remainingPrepaid).toBe(47000);
  });

  it('剛好等於預收餘額也可以', () => {
    expect(ok(applyPrepaid(P1, 10000, 10000, opts())).remainingPrepaid).toBe(0);
  });

  it('剛好等於該期未足額金額也可以（已入 4000，抵充 6000）', () => {
    const r = ok(applyPrepaid(P1, 50000, 6000, opts([existing('p1', 4000)])));
    expect(r.allocation.amount).toBe(6000);
  });

  it('拒絕超過預收餘額（差 1 元）', () => {
    expect(applyPrepaid(P1, 9999, 10000, opts())).toEqual({ ok: false, reason: 'exceeds_prepaid_balance' });
  });

  it('拒絕超過該期未足額金額（差 1 元）', () => {
    expect(applyPrepaid(P1, 50000, 6001, opts([existing('p1', 4000)]))).toEqual({
      ok: false,
      reason: 'exceeds_outstanding',
    });
  });

  it('期別已足額時任何抵充都超過未足額金額', () => {
    expect(applyPrepaid(P1, 50000, 1, opts([existing('p1', 10000)]))).toEqual({
      ok: false,
      reason: 'exceeds_outstanding',
    });
  });

  it('失效的配置不算已入帳', () => {
    const r = applyPrepaid(P1, 50000, 10000, opts([existing('p1', 10000, { active: false })]));
    expect(r.ok).toBe(true);
  });

  it('預收餘額為 0 時拒絕', () => {
    expect(applyPrepaid(P1, 0, 1, opts())).toEqual({ ok: false, reason: 'exceeds_prepaid_balance' });
  });

  it('押金期別不得抵充：執行時也擋 → wrong_kind', () => {
    const bad = { ...P1, kind: 'deposit' } as unknown as ReceivablePeriod;
    expect(applyPrepaid(bad, 50000, 1, opts())).toEqual({ ok: false, reason: 'wrong_kind' });
  });

  it('已取消的期別不得抵充', () => {
    expect(applyPrepaid({ ...P1, state: 'cancelled' }, 50000, 1, opts())).toEqual({
      ok: false,
      reason: 'period_cancelled',
    });
  });

  it.each([0, -1, 1.5, Number.NaN])('金額 %s → invalid_amount', (amount) => {
    expect(applyPrepaid(P1, 50000, amount, opts())).toEqual({ ok: false, reason: 'invalid_amount' });
  });

  it('預收餘額不是 0 以上整數 → invalid_amount', () => {
    expect(applyPrepaid(P1, -1, 1, opts())).toEqual({ ok: false, reason: 'invalid_amount' });
    expect(applyPrepaid(P1, 1.5, 1, opts())).toEqual({ ok: false, reason: 'invalid_amount' });
  });
});

describe('reallocate（改配置：舊的失效，新的寫入，合計不變）', () => {
  const A1 = existing('p1', 10000, { id: 'a-r1-p1', sourceId: 'r1' });
  const A2 = existing('p2', 5000, { id: 'a-r1-p2', sourceId: 'r1' });

  it('把 p1 的 10000 整筆改配到 p3', () => {
    const r = ok(
      reallocate([A1, A2], [{ allocationId: 'a-r1-p1', to: [{ periodId: 'p3', amount: 10000 }] }], PERIODS),
    );
    expect(r.invalidated).toEqual(['a-r1-p1']);
    expect(r.created).toEqual([{ sourceId: 'r1', periodId: 'p3', amount: 10000, source: 'receipt', kind: 'rent' }]);
  });

  it('一筆拆成多期：p1 的 10000 改成 p2 4000 加 p3 6000', () => {
    const r = ok(
      reallocate(
        [A1],
        [{ allocationId: 'a-r1-p1', to: [{ periodId: 'p2', amount: 4000 }, { periodId: 'p3', amount: 6000 }] }],
        PERIODS,
      ),
    );
    expect(r.created.map((a) => [a.periodId, a.amount])).toEqual([['p2', 4000], ['p3', 6000]]);
  });

  it('一次改多筆', () => {
    const r = ok(
      reallocate(
        [A1, A2],
        [
          { allocationId: 'a-r1-p1', to: [{ periodId: 'p3', amount: 10000 }] },
          { allocationId: 'a-r1-p2', to: [{ periodId: 'p1', amount: 5000 }] },
        ],
        PERIODS,
      ),
    );
    expect(r.invalidated).toEqual(['a-r1-p1', 'a-r1-p2']);
    expect(r.created.map((a) => [a.periodId, a.amount])).toEqual([['p3', 10000], ['p1', 5000]]);
  });

  it('改配置後的期別狀態重算', () => {
    const r = ok(
      reallocate([A1], [{ allocationId: 'a-r1-p1', to: [{ periodId: 'p2', amount: 10000 }] }], PERIODS),
    );
    const after = [
      ...[A1].map((a) => (r.invalidated.includes(a.id) ? { ...a, active: false } : a)),
      ...r.created.map((d) => stored(d)),
    ];
    expect(periodStatus(P1, after)).toBe('unpaid');
    expect(periodStatus(P2, after)).toBe('paid');
  });

  it('預收抵充的配置改配置後仍是 prepaid 來源', () => {
    const pre = existing('p1', 3000, { id: 'a-pre', sourceId: 'ap1', source: 'prepaid' });
    const r = ok(reallocate([pre], [{ allocationId: 'a-pre', to: [{ periodId: 'p2', amount: 3000 }] }], PERIODS));
    expect(r.created[0]).toMatchObject({ source: 'prepaid', sourceId: 'ap1' });
  });

  describe('拒絕', () => {
    const change = (to: { periodId: string; amount: number }[], allocationId = 'a-r1-p1') => [{ allocationId, to }];

    it('新金額合計不等於原金額 → amount_mismatch', () => {
      expect(reallocate([A1], change([{ periodId: 'p2', amount: 9999 }]), PERIODS)).toEqual({
        ok: false,
        reason: 'amount_mismatch',
      });
      expect(reallocate([A1], change([{ periodId: 'p2', amount: 10001 }]), PERIODS)).toEqual({
        ok: false,
        reason: 'amount_mismatch',
      });
    });

    it('配置不存在 → unknown_allocation', () => {
      expect(reallocate([A1], change([{ periodId: 'p2', amount: 10000 }], 'nope'), PERIODS)).toEqual({
        ok: false,
        reason: 'unknown_allocation',
      });
    });

    it('配置已失效 → inactive_allocation', () => {
      const dead = { ...A1, active: false };
      expect(reallocate([dead], change([{ periodId: 'p2', amount: 10000 }]), PERIODS)).toEqual({
        ok: false,
        reason: 'inactive_allocation',
      });
    });

    it('同一筆配置出現兩次 → duplicate_change', () => {
      const both = [
        { allocationId: 'a-r1-p1', to: [{ periodId: 'p2', amount: 10000 }] },
        { allocationId: 'a-r1-p1', to: [{ periodId: 'p3', amount: 10000 }] },
      ];
      expect(reallocate([A1], both, PERIODS)).toEqual({ ok: false, reason: 'duplicate_change' });
    });

    it('目標期別不存在 → unknown_period', () => {
      expect(reallocate([A1], change([{ periodId: 'nope', amount: 10000 }]), PERIODS)).toEqual({
        ok: false,
        reason: 'unknown_period',
      });
    });

    it('目標期別已取消 → period_cancelled', () => {
      const cancelled = mk('p4', '2026-04', { state: 'cancelled' });
      expect(reallocate([A1], change([{ periodId: 'p4', amount: 10000 }]), [...PERIODS, cancelled])).toEqual({
        ok: false,
        reason: 'period_cancelled',
      });
    });

    it('目標期別會超配 → exceeds_period_amount', () => {
      // p2 已有 5000，再加 10000 會超過 10000
      expect(reallocate([A1, A2], change([{ periodId: 'p2', amount: 10000 }]), PERIODS)).toEqual({
        ok: false,
        reason: 'exceeds_period_amount',
      });
    });

    it('同一筆目標期別重複 → duplicate_period', () => {
      expect(
        reallocate([A1], change([{ periodId: 'p2', amount: 5000 }, { periodId: 'p2', amount: 5000 }]), PERIODS),
      ).toEqual({ ok: false, reason: 'duplicate_period' });
    });

    it.each([0, -5, 2.5])('新金額 %s → invalid_amount', (amount) => {
      expect(reallocate([A1], change([{ periodId: 'p2', amount }, { periodId: 'p3', amount: 10000 - amount }]), PERIODS))
        .toEqual({ ok: false, reason: 'invalid_amount' });
    });

    it('新配置為空 → amount_mismatch', () => {
      expect(reallocate([A1], change([]), PERIODS)).toEqual({ ok: false, reason: 'amount_mismatch' });
    });

    it('互換位置不算超配：p1 與 p2 的配置對調', () => {
      const x = existing('p1', 10000, { id: 'x', sourceId: 'r1' });
      const y = existing('p2', 10000, { id: 'y', sourceId: 'r2' });
      const r = reallocate(
        [x, y],
        [
          { allocationId: 'x', to: [{ periodId: 'p2', amount: 10000 }] },
          { allocationId: 'y', to: [{ periodId: 'p1', amount: 10000 }] },
        ],
        PERIODS,
      );
      expect(r.ok).toBe(true);
    });
  });

  it('不改動輸入', () => {
    const snapshot = structuredClone([A1, A2]);
    reallocate([A1, A2], [{ allocationId: 'a-r1-p1', to: [{ periodId: 'p3', amount: 10000 }] }], PERIODS);
    expect([A1, A2]).toEqual(snapshot);
  });
});

// 性質測試：用自己寫的種子亂數（不新增套件）。
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

function sumActive(allocations: readonly Allocation[]): number {
  return allocations.filter((a) => a.active).reduce((s, a) => s + a.amount, 0);
}

function apply(allocations: Allocation[], result: { invalidated: string[]; created: AllocationDraft[] }): Allocation[] {
  return [
    ...allocations.map((a) => (result.invalidated.includes(a.id) ? { ...a, active: false } : a)),
    ...result.created.map((d) => stored(d)),
  ];
}

describe('性質測試（種子亂數）', () => {
  const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

  it('reallocate 成功時，有效配置的金額合計不變，且沒有期別超配', () => {
    let successes = 0;
    for (const seed of SEEDS) {
      const r = rng(seed);
      const periods = Array.from({ length: int(r, 2, 8) }, (_, i) =>
        mk(`q${i}`, `2026-${String(i + 1).padStart(2, '0')}`, { amount: int(r, 1, 5) * 5000 }),
      );
      // 先用 allocateReceipt 連續入帳產生一組合法的既有配置
      let allocations: Allocation[] = [];
      for (let n = 0; n < int(r, 1, 5); n++) {
        const res = allocateReceipt(periods, int(r, 1, 30000), { receiptId: `r${n}`, allocations });
        if (res.ok) allocations = [...allocations, ...res.allocations.map((d) => stored(d))];
      }
      const before = sumActive(allocations);
      const targets = allocations.filter(() => r() < 0.5);
      const changes = targets.map((a) => {
        const k = int(r, 1, 3);
        const cuts = new Set<number>();
        while (cuts.size < Math.min(k - 1, a.amount - 1)) cuts.add(int(r, 1, a.amount - 1));
        const points = [0, ...[...cuts].sort((x, y) => x - y), a.amount];
        const chosen = [...periods].sort(() => r() - 0.5).slice(0, points.length - 1);
        return {
          allocationId: a.id,
          to: chosen.map((p, i) => ({ periodId: p.id, amount: points[i + 1] - points[i] })),
        };
      });
      const res = reallocate(allocations, changes, periods);
      if (!res.ok) continue; // 超配等合法拒絕不計
      successes += 1;
      const after = apply(allocations, res);
      expect(sumActive(after)).toBe(before);
      for (const p of periods) expect(allocatedAmount(p, after)).toBeLessThanOrEqual(p.amount);
      expect(res.created.every((d) => Number.isSafeInteger(d.amount) && d.amount > 0)).toBe(true);
    }
    expect(successes).toBeGreaterThan(30); // 確認性質真的被執行，不是全被拒絕
  });

  it('allocateReceipt：配置合計加預收等於入帳金額，每期不超配，有效配置只增不減', () => {
    for (const seed of SEEDS) {
      const r = rng(seed * 7919);
      const periods = Array.from({ length: int(r, 1, 8) }, (_, i) =>
        mk(`q${i}`, `2026-${String(i + 1).padStart(2, '0')}`, {
          amount: int(r, 1, 6) * 4000,
          state: r() < 0.15 ? 'cancelled' : 'active',
        }),
      );
      let allocations: Allocation[] = [];
      for (let n = 0; n < 6; n++) {
        const amount = int(r, 1, 40000);
        const res = allocateReceipt(periods, amount, { receiptId: `r${n}`, allocations });
        const ok2 = ok(res);
        expect(ok2.allocations.reduce((s, a) => s + a.amount, 0) + ok2.prepaid).toBe(amount);
        allocations = [...allocations, ...ok2.allocations.map((d) => stored(d))];
        for (const p of periods) {
          if (p.state === 'cancelled') expect(allocatedAmount(p, allocations)).toBe(0);
          else expect(allocatedAmount(p, allocations)).toBeLessThanOrEqual(p.amount);
        }
      }
    }
  });

  it('applyPrepaid：成功時不超過預收餘額與未足額金額，失敗時不產生配置', () => {
    for (const seed of SEEDS) {
      const r = rng(seed * 104729);
      const period = mk('q', '2026-01', { amount: int(r, 1, 10) * 1000 });
      const allocations = [existing('q', int(r, 0, period.amount))];
      const balance = int(r, 0, 12000);
      const amount = int(r, 1, 12000);
      const outstanding = period.amount - allocations[0].amount;
      const res = applyPrepaid(period, balance, amount, { applicationId: 'ap', allocations });
      expect(res.ok).toBe(amount <= balance && amount <= outstanding);
      if (res.ok) expect(res.remainingPrepaid).toBe(balance - amount);
    }
  });
});

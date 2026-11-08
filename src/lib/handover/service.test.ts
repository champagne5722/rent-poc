import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_OWNER_PARTY_ID, demoHandoverSeed } from './demo-seed';
import { createMemoryHandoverStore } from './memory-store';
import {
  cancelHandover,
  confirmHandover,
  getHandoverDetail,
  listOwnerHandovers,
  saveManualFields,
  startHandovers,
  taipeiDate,
} from './service';
import type { HandoverStore } from './store';

const OWNER = DEMO_OWNER_PARTY_ID;
// 台灣時間 2026-11-08 上午 9 點
const NOW = new Date('2026-11-08T01:00:00.000Z');

let store: HandoverStore;

beforeEach(() => {
  store = createMemoryHandoverStore(demoHandoverSeed());
});

async function draftFor(rentalUnitId: string) {
  const started = await startHandovers(store, OWNER, 'mc-0101', NOW);
  if (!started.ok) throw new Error(started.errors.join());
  const list = await listOwnerHandovers(store, OWNER);
  return list.find((item) => item.record.rentalUnitId === rentalUnitId && item.record.state === 'draft')!.record.id;
}

describe('taipeiDate', () => {
  it('以台灣時間換日', () => {
    expect(taipeiDate(new Date('2026-11-07T15:59:59.000Z'))).toBe('2026-11-07');
    expect(taipeiDate(new Date('2026-11-07T16:00:00.000Z'))).toBe('2026-11-08');
  });
});

describe('startHandovers', () => {
  it('選一個委託管理案件，委託標的清單上每個租賃單位各產生一份草稿', async () => {
    const result = await startHandovers(store, OWNER, 'mc-0101', NOW);
    expect(result).toMatchObject({ ok: true });
    const drafts = (await listOwnerHandovers(store, OWNER)).filter((item) => item.record.state === 'draft');
    expect(drafts.map((item) => item.record.rentalUnitId).sort()).toEqual(['ru-0101', 'ru-0102', 'ru-0103']);
  });

  it('已有進行中移交的租賃單位不重複產生草稿', async () => {
    await startHandovers(store, OWNER, 'mc-0101', NOW);
    const again = await startHandovers(store, OWNER, 'mc-0101', NOW);
    expect(again).toEqual({ ok: true, value: [] });
  });

  it('不是這位屋主的委託管理案件時拒絕', async () => {
    expect(await startHandovers(store, 'party-owner-demo-2', 'mc-0101', NOW)).toMatchObject({ ok: false });
  });
});

describe('getHandoverDetail', () => {
  it('草稿從事實即時產生六類與缺項，並附每位候選受託人的委託狀況', async () => {
    const id = await draftFor('ru-0101');
    const detail = (await getHandoverDetail(store, OWNER, id))!;
    expect(detail.snapshot.categories).toHaveLength(6);
    expect(detail.snapshot.missing.map((m) => m.key)).toEqual([
      'condition.equipment_attachments',
      'physical.keys',
      'physical.access_cards',
      'admin.committee_contact',
    ]);
    expect(detail.candidates.map((c) => [c.orgId, c.mandate])).toEqual([
      ['org-pe-beichen', 'valid'],
      ['org-pe-yuanfan', 'paper'],
      ['org-pe-yaoshi', 'none'],
    ]);
  });

  it('其他屋主讀不到', async () => {
    const id = await draftFor('ru-0101');
    expect(await getHandoverDetail(store, 'party-owner-demo-2', id)).toBeNull();
  });
});

describe('confirmHandover', () => {
  it('缺項沒有全部勾選知悉時不能確認', async () => {
    const id = await draftFor('ru-0101');
    const result = await confirmHandover(
      store,
      OWNER,
      id,
      { acknowledgedMissing: ['physical.keys'], target: { kind: 'mandatary', orgId: 'org-pe-beichen' } },
      NOW,
    );
    expect(result).toEqual({ ok: false, errors: ['還有 3 個缺項沒有勾選知悉。'] });
  });

  it('手填欄位填好後缺項減少，勾選剩下的缺項就能交給新受託人，狀態到 owner_confirmed', async () => {
    const id = await draftFor('ru-0101');
    await saveManualFields(
      store,
      OWNER,
      id,
      { keyHandover: '鑰匙 2 把', accessCardHandover: '門禁卡 1 張', committeeContact: '總幹事' },
      NOW,
    );
    const detail = (await getHandoverDetail(store, OWNER, id))!;
    expect(detail.snapshot.missing.map((m) => m.key)).toEqual(['condition.equipment_attachments']);

    const result = await confirmHandover(
      store,
      OWNER,
      id,
      {
        acknowledgedMissing: ['condition.equipment_attachments'],
        target: { kind: 'mandatary', orgId: 'org-pe-beichen' },
      },
      NOW,
    );
    expect(result).toMatchObject({ ok: true });
    const after = (await getHandoverDetail(store, OWNER, id))!;
    expect(after.record.state).toBe('owner_confirmed');
    expect(after.record.target).toEqual({ kind: 'mandatary', orgId: 'org-pe-beichen', name: '北辰租賃住宅管理股份有限公司' });
  });

  it('簽署中的案件交給沒有委託的人時，回傳全部擋下原因', async () => {
    const id = await draftFor('ru-0102');
    const detail = (await getHandoverDetail(store, OWNER, id))!;
    const result = await confirmHandover(
      store,
      OWNER,
      id,
      {
        acknowledgedMissing: detail.snapshot.missing.map((m) => m.key),
        target: { kind: 'mandatary', orgId: 'org-pe-yaoshi' },
      },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0]).toContain('簽署任務');
      expect(result.errors[1]).toContain('有效委託');
    }
  });

  it('改自管：屋主指定生效日與收款帳戶，持有人變更要附說明，確認後直接到 accepted', async () => {
    const id = await draftFor('ru-0101');
    const detail = (await getHandoverDetail(store, OWNER, id))!;
    const base = {
      acknowledgedMissing: detail.snapshot.missing.map((m) => m.key),
      target: { kind: 'self_managed', paymentAccountId: 'pa-owner-1', effectiveDate: '2026-12-01', evidenceNote: '' },
    } as const;

    expect(await confirmHandover(store, OWNER, id, base, NOW)).toEqual({
      ok: false,
      errors: ['收款帳戶持有人會從「青禾租賃住宅管理有限公司」改為「王美玲」，請附上說明。'],
    });

    const result = await confirmHandover(
      store,
      OWNER,
      id,
      { ...base, target: { ...base.target, evidenceNote: '押金 46,000 元由青禾於 11/30 匯回屋主帳戶' } },
      NOW,
    );
    expect(result).toMatchObject({ ok: true });
    const after = (await getHandoverDetail(store, OWNER, id))!;
    expect(after.record.state).toBe('accepted');
    expect(after.record.effectiveDate).toBe('2026-12-01');
  });

  it('改自管但生效日早於今天時擋下', async () => {
    const id = await draftFor('ru-0103');
    const detail = (await getHandoverDetail(store, OWNER, id))!;
    const result = await confirmHandover(
      store,
      OWNER,
      id,
      {
        acknowledgedMissing: detail.snapshot.missing.map((m) => m.key),
        target: { kind: 'self_managed', paymentAccountId: 'pa-owner-1', effectiveDate: '2026-11-07', evidenceNote: '' },
      },
      NOW,
    );
    expect(result).toEqual({ ok: false, errors: ['生效日早於今天。請選今天或之後的日期。'] });
  });
});

describe('cancelHandover', () => {
  it('生效前能取消', async () => {
    const id = await draftFor('ru-0101');
    expect(await cancelHandover(store, OWNER, id, NOW)).toMatchObject({ ok: true });
    expect((await getHandoverDetail(store, OWNER, id))!.record.state).toBe('cancelled');
  });

  it('交出側已完成（released）的移交不能取消', async () => {
    const result = await cancelHandover(store, OWNER, 'ho-0002', NOW);
    expect(result).toMatchObject({ ok: false });
    expect((await getHandoverDetail(store, OWNER, 'ho-0002'))!.cancellable).toBe(false);
  });
});

describe('listOwnerHandovers', () => {
  it('附兩側是否完成', async () => {
    const list = await listOwnerHandovers(store, OWNER);
    const sides = Object.fromEntries(list.map((item) => [item.record.id, item.sides]));
    expect(sides['ho-0001']).toEqual({ released: true, received: true });
    expect(sides['ho-0002']).toEqual({ released: true, received: false });
  });
});

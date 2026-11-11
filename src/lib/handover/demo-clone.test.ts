import { describe, expect, it } from 'vitest';
import { cloneDemoHandover, DEMO_HANDOVER_VARIANTS, isDemoHandoverVariant } from './demo-clone';
import { createMemoryHandoverStore } from './memory-store';
import { demoHandoverSeed } from './demo-seed';
import { getHandoverDetail } from './service';

describe('cloneDemoHandover', () => {
  it('換成指定的屋主與 ID，其他屋主讀不到', async () => {
    const store = createMemoryHandoverStore(demoHandoverSeed());
    const record = cloneDemoHandover('owner_confirmed', 'party-real-1', 'ho-9001');
    expect(record).not.toBeNull();
    await store.saveHandover(record!);
    expect(await getHandoverDetail(store, 'party-real-1', 'ho-9001')).not.toBeNull();
    expect(await getHandoverDetail(store, 'party-other', 'ho-9001')).toBeNull();
  });

  it('草稿只留建立事件，手填欄位與知悉的缺項都是空的', () => {
    const record = cloneDemoHandover('draft', 'party-real-1', 'ho-9002')!;
    expect(record.state).toBe('draft');
    expect(record.events).toHaveLength(1);
    expect(record.acknowledgedMissing).toEqual([]);
    expect(Object.values(record.manual).every((v) => v === '')).toBe(true);
  });

  it('已完成的移交帶凍結快照', () => {
    const record = cloneDemoHandover('completed', 'party-real-1', 'ho-9003')!;
    expect(record.state).toBe('completed');
    expect(record.frozenSnapshot).not.toBeNull();
  });

  it('不改到示範資料本身', () => {
    cloneDemoHandover('draft', 'party-real-1', 'ho-9004');
    const source = demoHandoverSeed().handovers.find((h) => h.id === 'ho-0004')!;
    expect(source.state).toBe('owner_confirmed');
    expect(source.ownerPartyId).toBe('party-owner-demo-1');
  });

  it('variant 只認三種', () => {
    for (const v of DEMO_HANDOVER_VARIANTS) expect(isDemoHandoverVariant(v)).toBe(true);
    expect(isDemoHandoverVariant('released')).toBe(false);
    expect(isDemoHandoverVariant(undefined)).toBe(false);
  });
});

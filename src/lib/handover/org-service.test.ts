import { unzipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import { simulateReceive, simulateRelease } from './demo-effective';
import { DEMO_OWNER_PARTY_ID, demoHandoverSeed } from './demo-seed';
import { createMemoryHandoverStore } from './memory-store';
import {
  acceptHandover,
  exportHandoverPackage,
  getOrgHandoverDetail,
  listOrgHandovers,
  type AcceptHandoverInput,
} from './org-service';
import { startHandovers } from './service';
import { hashHandoverSnapshot } from './snapshot-hash';
import type { HandoverStore } from './store';

const BEICHEN = 'org-pe-beichen';
const SUILIN = 'org-pe-suilin';
const QINGCHUAN = 'org-pe-qingchuan';
const YAOSHI = 'org-pe-yaoshi';
// 台灣時間 2026-11-08 上午 9 點
const NOW = new Date('2026-11-08T01:00:00.000Z');

let store: HandoverStore;

beforeEach(() => {
  store = createMemoryHandoverStore(demoHandoverSeed());
});

const ACCEPT: AcceptHandoverInput = {
  effectiveDate: '2026-11-15',
  paymentAccountId: 'pa-beichen-1',
  evidenceNote: '押金與預收租金由穗林匯入北辰的收款帳戶。',
  evidenceFile: null,
};

describe('listOrgHandovers', () => {
  it('分成移交給我的案件與我交出的案件，不列屋主還沒確認的草稿', async () => {
    // 屋主從北辰的委託管理案件發起草稿，北辰是交出方，但草稿不該出現
    await startHandovers(store, DEMO_OWNER_PARTY_ID, 'mc-0201', NOW);
    const lists = await listOrgHandovers(store, BEICHEN);
    expect(lists.incoming.map((item) => item.record.id).sort()).toEqual(['ho-0001', 'ho-0002', 'ho-0003', 'ho-0004']);
    expect(lists.outgoing.map((item) => item.record.id)).toEqual(['ho-0005']);
    expect(lists.incoming.find((item) => item.record.id === 'ho-0002')!.sides).toEqual({
      released: true,
      received: false,
    });
  });

  it('與移交無關的組織看不到', async () => {
    const lists = await listOrgHandovers(store, 'org-pe-unknown');
    expect(lists).toEqual({ incoming: [], outgoing: [] });
  });
});

describe('getOrgHandoverDetail', () => {
  it('接收方在接手前看到即時產生的移交包內容、收款帳戶與目前的持有人', async () => {
    const detail = (await getOrgHandoverDetail(store, BEICHEN, 'ho-0003', NOW))!;
    expect(detail.role).toBe('receiver');
    expect(detail.snapshot!.categories).toHaveLength(6);
    expect(detail.paymentAccounts.map((a) => a.id)).toEqual(['pa-beichen-1', 'pa-beichen-2']);
    expect(detail.currentAccountHolder).toBe('穗林物業管理顧問有限公司');
    expect(detail.blockReasons).toEqual([]);
    expect(detail.canExport).toBe(false);
  });

  it('接手前就列出全部擋下原因', async () => {
    const detail = (await getOrgHandoverDetail(store, BEICHEN, 'ho-0004', NOW))!;
    expect(detail.blockReasons.map((r) => r.code)).toEqual(['active_signing_task', 'no_valid_mandate']);
  });

  it('舊受託人只拿到凍結的快照，沒有收款帳戶可選，完成後能匯出', async () => {
    const detail = (await getOrgHandoverDetail(store, BEICHEN, 'ho-0005', NOW))!;
    expect(detail.role).toBe('releaser');
    expect(detail.snapshot).toEqual(detail.record.frozenSnapshot);
    expect(hashHandoverSnapshot(detail.snapshot)).toBe(detail.record.snapshotHash);
    expect(detail.paymentAccounts).toEqual([]);
    expect(detail.canExport).toBe(true);
  });

  it('舊受託人在交出側生效前看不到快照', async () => {
    const detail = (await getOrgHandoverDetail(store, SUILIN, 'ho-0003', NOW))!;
    expect(detail.role).toBe('releaser');
    expect(detail.snapshot).toBeNull();
  });

  it('不是交出方也不是接收方時回傳 null', async () => {
    expect(await getOrgHandoverDetail(store, YAOSHI, 'ho-0003', NOW)).toBeNull();
  });

  it('屋主還沒確認的草稿，交出方也看不到', async () => {
    const started = await startHandovers(store, DEMO_OWNER_PARTY_ID, 'mc-0201', NOW);
    if (!started.ok) throw new Error(started.errors.join());
    expect(await getOrgHandoverDetail(store, BEICHEN, started.value[0], NOW)).toBeNull();
  });
});

describe('acceptHandover', () => {
  it('指定生效日與收款帳戶後轉到 accepted，持有人變更時記下說明', async () => {
    expect(await acceptHandover(store, BEICHEN, 'ho-0003', ACCEPT, NOW)).toEqual({ ok: true, value: undefined });
    const record = (await store.getHandover('ho-0003'))!;
    expect(record.state).toBe('accepted');
    expect(record.effectiveDate).toBe('2026-11-15');
    expect(record.receiverAccount).toEqual({
      paymentAccountId: 'pa-beichen-1',
      label: '示範銀行 ****8801',
      holderName: '北辰租賃住宅管理股份有限公司',
      evidence: { note: '押金與預收租金由穗林匯入北辰的收款帳戶。', file: null },
    });
    expect(record.events.at(-1)).toEqual({ type: 'handover_accept', at: NOW.toISOString() });
  });

  it('只附檔案也可以，記下檔名、大小與 SHA-256', async () => {
    const bytes = new TextEncoder().encode('bank transfer receipt');
    const result = await acceptHandover(
      store,
      BEICHEN,
      'ho-0003',
      { ...ACCEPT, evidenceNote: '  ', evidenceFile: { name: '匯款單.pdf', bytes } },
      NOW,
    );
    expect(result.ok).toBe(true);
    expect((await store.getHandover('ho-0003'))!.receiverAccount!.evidence).toEqual({
      note: null,
      file: {
        name: '匯款單.pdf',
        size: 21,
        sha256: 'c5dd1cc848def77987138422df40500e49e26199eec6979d1fe984ec5574c4ab',
      },
    });
  });

  it('持有人變更卻沒有檔案也沒有說明時擋下', async () => {
    const result = await acceptHandover(store, BEICHEN, 'ho-0003', { ...ACCEPT, evidenceNote: ' ' }, NOW);
    expect(result).toEqual({
      ok: false,
      errors: [
        '收款帳戶持有人會從「穗林物業管理顧問有限公司」改為「北辰租賃住宅管理股份有限公司」，請附上檔案或說明。',
      ],
    });
    expect((await store.getHandover('ho-0003'))!.state).toBe('owner_confirmed');
  });

  it('生效日早於今天時擋下', async () => {
    const result = await acceptHandover(store, BEICHEN, 'ho-0003', { ...ACCEPT, effectiveDate: '2026-11-07' }, NOW);
    expect(result).toEqual({ ok: false, errors: ['生效日早於今天。請選今天或之後的日期。'] });
  });

  it('生效日與收款帳戶都必須指定', async () => {
    const result = await acceptHandover(
      store,
      BEICHEN,
      'ho-0003',
      { ...ACCEPT, effectiveDate: '', paymentAccountId: 'pa-suilin-1' },
      NOW,
    );
    expect(result).toEqual({ ok: false, errors: ['請指定生效日。', '請選擇收款帳戶。'] });
  });

  it('再跑一次擋下條件，列出全部原因', async () => {
    const result = await acceptHandover(store, BEICHEN, 'ho-0004', { ...ACCEPT, effectiveDate: '2026-11-01' }, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(3);
    expect(result.errors[0]).toContain('進行中的簽署任務');
  });

  it('證明檔案太大時擋下', async () => {
    const bytes = new Uint8Array(800 * 1024 + 1);
    const result = await acceptHandover(
      store,
      BEICHEN,
      'ho-0003',
      { ...ACCEPT, evidenceFile: { name: 'big.pdf', bytes } },
      NOW,
    );
    expect(result).toEqual({ ok: false, errors: ['證明檔案超過 800 KB。請壓縮後再上傳，或改填說明。'] });
  });

  it('不是接收方，或不是等待接手時拒絕', async () => {
    expect(await acceptHandover(store, SUILIN, 'ho-0003', ACCEPT, NOW)).toEqual({
      ok: false,
      errors: ['找不到這個移交。'],
    });
    expect(await acceptHandover(store, BEICHEN, 'ho-0002', ACCEPT, NOW)).toEqual({
      ok: false,
      errors: ['這個移交已經接手了。'],
    });
  });
});

describe('模擬生效（只在記憶體 adapter）', () => {
  it('accepted 先到 released 並凍結快照與雜湊，再到 completed', async () => {
    await acceptHandover(store, BEICHEN, 'ho-0003', ACCEPT, NOW);
    expect(await simulateRelease(store, BEICHEN, 'ho-0003', NOW)).toEqual({ ok: true, value: undefined });
    const released = (await store.getHandover('ho-0003'))!;
    expect(released.state).toBe('released');
    expect(released.frozenSnapshot!.categories).toHaveLength(6);
    expect(released.snapshotHash).toBe(hashHandoverSnapshot(released.frozenSnapshot));

    expect(await simulateReceive(store, BEICHEN, 'ho-0003', NOW)).toEqual({ ok: true, value: undefined });
    expect((await store.getHandover('ho-0003'))!.state).toBe('completed');
  });

  it('還沒接手時不能模擬生效，交出側完成前不能模擬接收側', async () => {
    expect(await simulateRelease(store, BEICHEN, 'ho-0003', NOW)).toMatchObject({ ok: false });
    expect(await simulateReceive(store, BEICHEN, 'ho-0003', NOW)).toMatchObject({ ok: false });
  });

  it('與移交無關的組織不能模擬', async () => {
    expect(await simulateReceive(store, YAOSHI, 'ho-0002', NOW)).toEqual({ ok: false, errors: ['找不到這個移交。'] });
  });
});

describe('exportHandoverPackage', () => {
  it('完成後屋主、交出方、接收方都能匯出同一份移交包', async () => {
    const viewers = [
      { kind: 'owner', partyId: DEMO_OWNER_PARTY_ID },
      { kind: 'org', orgId: QINGCHUAN },
      { kind: 'org', orgId: BEICHEN },
    ] as const;
    const results = await Promise.all(viewers.map((viewer) => exportHandoverPackage(store, viewer, 'ho-0001')));
    for (const result of results) {
      if (!result.ok) throw new Error(result.errors.join());
      expect(result.value.filename).toBe('handover-package-ho-0001.zip');
      expect(Object.keys(unzipSync(result.value.bytes))).toEqual([
        'index.json',
        'ledger-snapshot.json',
        'signed/management-contract-mc-0202.pdf',
        'signed/lease-contract-lc-0202.pdf',
      ]);
    }
  });

  it('PDF 的雜湊與快照記錄的一致', async () => {
    const result = await exportHandoverPackage(store, { kind: 'org', orgId: BEICHEN }, 'ho-0005');
    if (!result.ok) throw new Error(result.errors.join());
    const index = JSON.parse(new TextDecoder().decode(unzipSync(result.value.bytes)['index.json']));
    expect(index.snapshotHash.matchesSnapshot).toBe(true);
    expect(index.signedDocuments.map((d: { status: string }) => d.status)).toEqual(['included', 'included']);
  });

  it('還沒完成時不能匯出', async () => {
    expect(await exportHandoverPackage(store, { kind: 'org', orgId: BEICHEN }, 'ho-0002')).toEqual({
      ok: false,
      errors: ['移交完成後才能匯出移交包。'],
    });
  });

  it('不是屋主、交出方或接收方時拒絕', async () => {
    const notFound = { ok: false, errors: ['找不到這個移交。'] };
    expect(await exportHandoverPackage(store, { kind: 'org', orgId: YAOSHI }, 'ho-0001')).toEqual(notFound);
    expect(await exportHandoverPackage(store, { kind: 'owner', partyId: 'party-owner-demo-2' }, 'ho-0001')).toEqual(
      notFound,
    );
  });
});

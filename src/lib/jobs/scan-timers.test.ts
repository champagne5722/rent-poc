import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTx } from '../pg/database';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import { newUlid } from '../pg/ulid';
import type { ControlTx, OrgTx } from '../pg/with-tx';
import { timerIdempotencyKey as c1TimerKey } from '../registry-rules/timers';
import { taipeiToday } from './dates';
import { createTimerRegistry, timerIdempotencyKey, type TimerFire } from './timers/registry';
import { runScanTimers } from './scan-timers';

// 計時器的註冊與執行機制（ADR-0020 決議 3、7，MIL-86）。A 線只用測試用的計時器驗證，
// 真正的計時器由 C 線（MIL-112）、E 線（MIL-129、130、136）、F 線（MIL-107）註冊。
// 效果與冪等紀錄在同一個交易：寫入冪等紀錄成功才執行效果，效果失敗整筆回滾。

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(async () => {
  await kit.reset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const TODAY = '2026-11-09';
const inOrg = <T,>(orgId: string, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId }, fn);

// 測試用計時器：每個組織裡有「待辦」列，到期就要處理。效果是把列標為已處理並計數
async function seedTodo(orgId: string, subjectId: string) {
  await inOrg(orgId, (tx) =>
    tx.query(`INSERT INTO org.contracts (id, org_id, fields) VALUES ($1, current_setting('app.org_id', true), '{}'::jsonb)`, [subjectId]),
  );
}

function orgTimer(name: string, effects: string[], over: { scan?: (tx: OrgTx, today: string) => Promise<TimerFire[]>; failOn?: string } = {}) {
  return {
    name,
    scope: 'org' as const,
    scan:
      over.scan ??
      (async (tx: OrgTx, today: string) => {
        const { rows } = await tx.query<{ id: string }>('SELECT id FROM org.contracts ORDER BY id');
        return rows.map((r) => ({ subjectId: r.id, event: 'probe_due', date: today }));
      }),
    fire: async (tx: OrgTx, fire: TimerFire) => {
      // 效果要在同一個交易寫進資料庫，回滾才看得出來
      await tx.query(`UPDATE org.contracts SET updated_at = now() WHERE id = $1`, [fire.subjectId]);
      if (over.failOn === fire.subjectId) throw new Error('效果失敗');
      effects.push(`${name}:${fire.subjectId}`);
    },
  };
}

const fireRows = () =>
  withTx({ kind: 'control' }, async (tx) => {
    const { rows } = await tx.query<{ idempotency_key: string; timer: string; org_id: string | null }>(
      'SELECT idempotency_key, timer, org_id FROM control.timer_fires ORDER BY idempotency_key',
    );
    return rows;
  });

describe('冪等鍵', () => {
  it('是主體、事件、日期，格式與 C 線純函式的 timerIdempotencyKey 相同', () => {
    const subject = newUlid();
    expect(timerIdempotencyKey({ subjectId: subject, event: 'mandate_expired', date: '2026-11-09' })).toBe(
      c1TimerKey(subject, 'mandate_expired', '2026-11-09'),
    );
    expect(timerIdempotencyKey({ subjectId: 'S', event: 'e', date: '2026-11' })).toBe('S:e:2026-11');
  });
});

describe('註冊', () => {
  it('同名的計時器不能註冊兩次', () => {
    const registry = createTimerRegistry();
    registry.register(orgTimer('probe', []));
    expect(() => registry.register(orgTimer('probe', []))).toThrow(/已註冊/);
  });

  it('名稱只允許小寫英數與底線', () => {
    expect(() => createTimerRegistry().register(orgTimer('Bad Name', []))).toThrow(/名稱/);
  });
});

describe('執行', () => {
  it('組織內計時器：逐組織掃描，每個到期項目執行一次並留下冪等紀錄', async () => {
    const a = newUlid();
    const b = newUlid();
    await seedTodo(kit.orgA, a);
    await seedTodo(kit.orgB, b);
    const effects: string[] = [];
    const registry = createTimerRegistry();
    registry.register(orgTimer('probe', effects));

    const result = await runScanTimers(registry, { today: TODAY, limit: 100 });

    expect(effects.sort()).toEqual([`probe:${a}`, `probe:${b}`].sort());
    expect(result).toMatchObject({ today: TODAY, fired: 2, skipped: 0, failed: 0, truncated: false });
    expect(await fireRows()).toEqual(
      [
        { idempotency_key: `${a}:probe_due:${TODAY}`, timer: 'probe', org_id: kit.orgA },
        { idempotency_key: `${b}:probe_due:${TODAY}`, timer: 'probe', org_id: kit.orgB },
      ].sort((x, y) => x.idempotency_key.localeCompare(y.idempotency_key)),
    );
  });

  it('組織內計時器只看得到自己組織的資料（依組織脈絡掃描）', async () => {
    const a = newUlid();
    await seedTodo(kit.orgA, a);
    const seen: Record<string, string[]> = {};
    const registry = createTimerRegistry();
    registry.register({
      ...orgTimer('probe', []),
      scan: async (tx: OrgTx, today: string) => {
        const { rows } = await tx.query<{ id: string; org: string }>(
          `SELECT id, current_setting('app.org_id', true) AS org FROM org.contracts`,
        );
        for (const r of rows) (seen[r.org] ??= []).push(r.id);
        return rows.map((r) => ({ subjectId: r.id, event: 'probe_due', date: today }));
      },
    });

    await runScanTimers(registry, { today: TODAY, limit: 100 });

    expect(seen).toEqual({ [kit.orgA]: [a] });
  });

  it('同一天再掃一次：已執行的略過，效果不重複', async () => {
    await seedTodo(kit.orgA, newUlid());
    const effects: string[] = [];
    const registry = createTimerRegistry();
    registry.register(orgTimer('probe', effects));

    await runScanTimers(registry, { today: TODAY, limit: 100 });
    const second = await runScanTimers(registry, { today: TODAY, limit: 100 });

    expect(effects).toHaveLength(1);
    expect(second).toMatchObject({ fired: 0, skipped: 1, failed: 0 });
    expect(await fireRows()).toHaveLength(1);
  });

  it('隔天再掃：日期不同是新的鍵，會再執行（當日提醒型的計時器每天都有新的事件）', async () => {
    await seedTodo(kit.orgA, newUlid());
    const effects: string[] = [];
    const registry = createTimerRegistry();
    registry.register(orgTimer('probe', effects));

    await runScanTimers(registry, { today: '2026-11-09', limit: 100 });
    await runScanTimers(registry, { today: '2026-11-10', limit: 100 });

    expect(effects).toHaveLength(2);
  });

  it('日期固定的計時器（狀態驅動）補跑多日仍是同一把鍵', async () => {
    const id = newUlid();
    await seedTodo(kit.orgA, id);
    const effects: string[] = [];
    const registry = createTimerRegistry();
    registry.register(
      orgTimer('probe', effects, { scan: async () => [{ subjectId: id, event: 'mandate_expired', date: '2026-11-01' }] }),
    );

    await runScanTimers(registry, { today: '2026-11-09', limit: 100 });
    await runScanTimers(registry, { today: '2026-11-12', limit: 100 });

    expect(effects).toHaveLength(1);
  });

  it('效果失敗：整筆回滾，不留冪等紀錄，下一次掃描會重試；其他項目不受影響', async () => {
    const bad = newUlid();
    const good = newUlid();
    await seedTodo(kit.orgA, bad);
    await seedTodo(kit.orgA, good);
    const effects: string[] = [];
    const registry = createTimerRegistry();
    registry.register(orgTimer('probe', effects, { failOn: bad }));

    const result = await runScanTimers(registry, { today: TODAY, limit: 100 });

    expect(result).toMatchObject({ fired: 1, failed: 1 });
    expect(result.failures).toEqual([{ timer: 'probe', key: `${bad}:probe_due:${TODAY}`, error: '效果失敗' }]);
    expect(effects).toEqual([`probe:${good}`]);
    expect((await fireRows()).map((r) => r.idempotency_key)).toEqual([`${good}:probe_due:${TODAY}`]);
    // 效果裡的寫入也回滾了
    const touched = await inOrg(kit.orgA, async (tx) => (await tx.query<{ id: string }>('SELECT id FROM org.contracts WHERE updated_at IS NOT NULL')).rows);
    expect(touched.map((r) => r.id)).toEqual([good]);

    // 修好之後下一次掃描補上
    const retry = createTimerRegistry();
    retry.register(orgTimer('probe', effects));
    await runScanTimers(retry, { today: TODAY, limit: 100 });
    expect(effects).toEqual([`probe:${good}`, `probe:${bad}`]);
  });

  it('一個計時器的掃描失敗，不影響其他計時器', async () => {
    await seedTodo(kit.orgA, newUlid());
    const effects: string[] = [];
    const registry = createTimerRegistry();
    registry.register(
      orgTimer('broken_scan', effects, {
        scan: async () => {
          throw new Error('掃描失敗');
        },
      }),
    );
    registry.register(orgTimer('works', effects));

    const result = await runScanTimers(registry, { today: TODAY, limit: 100 });

    expect(effects).toHaveLength(1);
    expect(result.failures).toContainEqual({ timer: 'broken_scan', key: null, error: '掃描失敗' });
  });

  it('全域計時器（資料在 registry，沒有組織）：用 control 脈絡掃描與執行，冪等紀錄的 org_id 是空的', async () => {
    const effects: string[] = [];
    const registry = createTimerRegistry();
    registry.register({
      name: 'global_probe',
      scope: 'global',
      scan: async (_tx: ControlTx, today: string) => [{ subjectId: 'ENTITY1', event: 'entity_recheck', date: today.slice(0, 7) }],
      fire: async (_tx: ControlTx, fire: TimerFire) => {
        effects.push(fire.subjectId);
      },
    });

    await runScanTimers(registry, { today: TODAY, limit: 100 });
    await runScanTimers(registry, { today: '2026-11-20', limit: 100 });

    expect(effects).toEqual(['ENTITY1']);
    expect(await fireRows()).toEqual([{ idempotency_key: 'ENTITY1:entity_recheck:2026-11', timer: 'global_probe', org_id: null }]);
  });

  it('每次最多執行 limit 筆，剩下的標示 truncated，下一次掃描補上', async () => {
    for (let i = 0; i < 3; i++) await seedTodo(kit.orgA, newUlid());
    const effects: string[] = [];
    const registry = createTimerRegistry();
    registry.register(orgTimer('probe', effects));

    const first = await runScanTimers(registry, { today: TODAY, limit: 2 });
    expect(first).toMatchObject({ fired: 2, truncated: true });
    expect(effects).toHaveLength(2);

    const second = await runScanTimers(registry, { today: TODAY, limit: 2 });
    expect(second).toMatchObject({ fired: 1, skipped: 2, truncated: false });
    expect(effects).toHaveLength(3);
  });

  it('掃出格式不合的項目：略過並記為失敗，其他項目照常', async () => {
    const good = newUlid();
    await seedTodo(kit.orgA, good);
    const effects: string[] = [];
    const registry = createTimerRegistry();
    registry.register(
      orgTimer('probe', effects, {
        // 只有 A 組織回傳項目，其他組織什麼都沒有
        scan: async (tx: OrgTx) => (await tx.query<{ o: string }>(`SELECT current_setting('app.org_id', true) AS o`)).rows[0].o !== kit.orgA ? [] : [
          { subjectId: 'has:colon', event: 'probe_due', date: TODAY },
          { subjectId: good, event: 'Probe Due', date: TODAY },
          { subjectId: good, event: 'probe_due', date: '11/09' },
          { subjectId: good, event: 'probe_due', date: TODAY },
        ],
      }),
    );

    const result = await runScanTimers(registry, { today: TODAY, limit: 100 });

    expect(result).toMatchObject({ fired: 1, failed: 3 });
    expect(effects).toEqual([`probe:${good}`]);
  });

  it('沒有註冊任何計時器：什麼都不做', async () => {
    expect(await runScanTimers(createTimerRegistry(), { today: TODAY, limit: 100 })).toMatchObject({
      timers: 0,
      fired: 0,
      failed: 0,
      truncated: false,
    });
  });

  it('平台組織不掃組織內計時器', async () => {
    const seenOrgs: string[] = [];
    const registry = createTimerRegistry();
    registry.register({
      ...orgTimer('probe', []),
      scan: async (tx: OrgTx) => {
        seenOrgs.push((await tx.query<{ o: string }>(`SELECT current_setting('app.org_id', true) AS o`)).rows[0].o);
        return [];
      },
    });

    await runScanTimers(registry, { today: TODAY, limit: 100 });

    expect(seenOrgs).not.toContain('00000000000000000000000001');
    expect(seenOrgs).toEqual(expect.arrayContaining([kit.orgA, kit.orgB]));
  });
});

describe('今天的日期', () => {
  it('以台灣日期計：UTC 16:00 之後已是台灣的隔天', () => {
    expect(taipeiToday(new Date('2026-11-09T15:59:59Z'))).toBe('2026-11-09');
    expect(taipeiToday(new Date('2026-11-09T16:00:00Z'))).toBe('2026-11-10');
  });
});

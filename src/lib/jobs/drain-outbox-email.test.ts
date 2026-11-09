import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockMailer, type MockMailer } from '../mailer/mock-mailer';
import { drainNotificationEmails, notify } from '../notifications';
import { withTx } from '../pg/database';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import type { OrgTx } from '../pg/with-tx';
import { OUTBOX_MAX_RETRIES } from '../signing-module/outbox';
import { createJobs, type JobNotifications, type JobSigning } from './jobs';
import { createTimerRegistry } from './timers/registry';

// drain-outbox 重試到期的通知 email（MIL-120 的 drainNotificationEmails 接到 MIL-86 的 job）。
// 通知模組用真的（PGlite），Mailer 用 Mock。簽署模組換成沒有工作的替身，專心看寄信。

let kit: RouteDb;
let mailer: MockMailer;
let failSend = false;

beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(async () => {
  await kit.reset();
  mailer = createMockMailer();
  failSend = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const NOW = new Date('2026-11-09T03:00:00Z');
const inOrg = <T,>(orgId: string, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId }, fn);

const idleSigning: JobSigning = { drainInbox: async () => [], drainOutbox: async () => [] };
const realEmails: JobNotifications = {
  drainEmails: (orgId, limit) =>
    drainNotificationEmails(orgId, limit, {
      mailer: () => ({
        ...mailer,
        send: async (message) => {
          if (failSend) throw new Error('寄信服務暫時無法使用');
          return mailer.send(message);
        },
      }),
    }),
};
const jobsWith = (notifications: JobNotifications = realEmails, limits?: { outbox?: number }) =>
  createJobs({ signing: idleSigning, notifications, timers: createTimerRegistry(), limits });

// 只排進 outbox，不派送：模擬「提交後派送失敗或沒派送」留下的待寄列
const queueEmail = (orgId: string, to: string) =>
  inOrg(orgId, (tx) =>
    notify(tx, { kind: 'rent.reminder', title: '繳租提醒', body: '本月租金尚未入帳', inApp: false, email: { to, from: '示範管理公司' } }),
  );

describe('drain-outbox 的通知 email', () => {
  it('逐組織寄出到期的通知 email，彙整結果，並記下寄出時間', async () => {
    await queueEmail(kit.orgA, 'a@example.com');
    await queueEmail(kit.orgB, 'b@example.com');

    const result = await jobsWith()['drain-outbox']({ now: NOW });

    expect(result).toMatchObject({ emails: { processed: 2, sent: 2, failed: 0, dead: 0 }, orgErrors: 0, truncated: false });
    expect(mailer.sent.map((m) => m.to).sort()).toEqual(['a@example.com', 'b@example.com']);
    const unsent = await inOrg(kit.orgA, async (tx) =>
      Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM org.notification_emails WHERE sent_at IS NULL`)).rows[0].n),
    );
    expect(unsent).toBe(0);
  });

  it('寄過的信不會重寄', async () => {
    await queueEmail(kit.orgA, 'a@example.com');
    const jobs = jobsWith();
    await jobs['drain-outbox']({ now: NOW });

    const second = await jobs['drain-outbox']({ now: NOW });

    expect(second).toMatchObject({ emails: { processed: 0 } });
    expect(mailer.sent).toHaveLength(1);
  });

  it('寄信失敗的列留著，下一次排程再試；寄出後不再重試', async () => {
    await queueEmail(kit.orgA, 'a@example.com');
    const jobs = jobsWith();
    failSend = true;

    const first = await jobs['drain-outbox']({ now: NOW });
    expect(first).toMatchObject({ emails: { processed: 1, failed: 1, dead: 0 } });
    expect(mailer.sent).toHaveLength(0);

    failSend = false;
    // 失敗後要等 next_attempt_at 才會到期。測試直接把它拉到現在
    await inOrg(kit.orgA, (tx) => tx.query(`UPDATE org.outbox SET next_attempt_at = now() WHERE action = 'send_email'`));
    const second = await jobs['drain-outbox']({ now: NOW });

    expect(second).toMatchObject({ emails: { sent: 1, failed: 0 } });
    expect(mailer.sent).toHaveLength(1);
  });

  it('重試用完轉 dead，job 結果標出並寫 error log', async () => {
    await queueEmail(kit.orgA, 'a@example.com');
    const jobs = jobsWith();
    failSend = true;
    let last: Record<string, unknown> = {};
    for (let i = 0; i <= OUTBOX_MAX_RETRIES; i++) {
      await inOrg(kit.orgA, (tx) => tx.query(`UPDATE org.outbox SET next_attempt_at = now() WHERE action = 'send_email' AND status = 'pending'`));
      last = await jobs['drain-outbox']({ now: NOW });
    }

    expect(last).toMatchObject({ emails: { failed: 1, dead: 1 } });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('轉人工處理清單'));
    await inOrg(kit.orgA, (tx) => tx.query(`UPDATE org.outbox SET next_attempt_at = now()`));
    expect(await jobs['drain-outbox']({ now: NOW })).toMatchObject({ emails: { processed: 0 } });
  });

  it('每次最多處理 limit 封，剩下的留給下一次', async () => {
    await queueEmail(kit.orgA, '1@example.com');
    await queueEmail(kit.orgA, '2@example.com');
    const jobs = jobsWith(realEmails, { outbox: 1 });

    const first = await jobs['drain-outbox']({ now: NOW });
    expect(first).toMatchObject({ emails: { processed: 1, sent: 1 }, truncated: true });

    const second = await jobs['drain-outbox']({ now: NOW });
    expect(second).toMatchObject({ emails: { processed: 1, sent: 1 } });
    expect(mailer.sent).toHaveLength(2);
  });

  it('一個組織的寄信出錯不影響其他組織，也不影響簽署動作', async () => {
    await queueEmail(kit.orgB, 'b@example.com');
    const flaky: JobNotifications = {
      drainEmails: async (orgId, limit) => {
        if (orgId === kit.orgA) throw new Error('A 組織的通知 drain 出錯');
        return realEmails.drainEmails(orgId, limit);
      },
    };
    const signingCalls: string[] = [];
    const jobs = createJobs({
      signing: { ...idleSigning, drainOutbox: async (orgId) => (signingCalls.push(orgId), []) },
      notifications: flaky,
      timers: createTimerRegistry(),
    });

    const result = await jobs['drain-outbox']({ now: NOW });

    expect(result).toMatchObject({ orgErrors: 1, emails: { sent: 1 } });
    expect(signingCalls).toContain(kit.orgA);
    expect(signingCalls).toContain(kit.orgB);
  });
});

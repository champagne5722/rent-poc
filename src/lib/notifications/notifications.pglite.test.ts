import os from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLocalFileStore } from '../file-store/local-file-store';
import { createMockMailer, type MockMailer } from '../mailer/mock-mailer';
import { withTx } from '../pg/database';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import { createMockProvider } from '../signing-module/mock-adapter';
import { createSigningModule } from '../signing-module/module';
import { listDeadOutbox, OUTBOX_MAX_RETRIES } from '../signing-module/outbox';
import {
  countUnread,
  dispatchNotificationEmail,
  drainNotificationEmails,
  listNotifications,
  markAllRead,
  markRead,
  notify,
  NotifyInputError,
  type NotifyInput,
} from './index';

// 通知模組（MIL-120，ADR-0050 決議 12）。走 notify() 與派送函式，PGlite 上跑，連線身分是 app_rw。

let kit: RouteDb;
let mailer: MockMailer;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(async () => {
  await kit.reset();
  mailer = createMockMailer();
});

const inOrg = <T,>(orgId: string, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId }, fn);
const inA = <T,>(fn: (tx: OrgTx) => Promise<T>) => inOrg(kit.orgA, fn);

const PARTY_1 = newUlid();
const PARTY_2 = newUlid();

const base = (over: Partial<NotifyInput> = {}): NotifyInput => ({
  kind: 'demo.test',
  title: '測試通知',
  body: '這是一則測試通知',
  ...over,
});
const email = { to: 'tenant@example.com', from: '大安管理公司', subject: '繳租提醒', text: '本月租金尚未入帳' };
const deps = () => ({ mailer: () => mailer });

const counts = () =>
  inA(async (tx) => {
    const q = async (table: string) => Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
    return { notifications: await q('org.notifications'), emails: await q('org.notification_emails'), outbox: await q('org.outbox') };
  });

describe('notify：同交易寫站內通知與 outbox 的 email 列', () => {
  it('兩個通道都寫：一則通知、一封待寄 email、一列 pending 的 outbox', async () => {
    const receipt = await inA((tx) => notify(tx, base({ email })));
    expect(receipt.notificationId).not.toBeNull();
    expect(receipt.emailId).not.toBeNull();
    expect(receipt.outboxId).not.toBeNull();
    const rows = await inA(async (tx) => ({
      outbox: (await tx.query(`SELECT action, subject_type, subject_id, status FROM org.outbox`)).rows,
      email: (await tx.query(`SELECT to_email, from_name, subject, body_text, notification_id, sent_at FROM org.notification_emails`)).rows,
    }));
    expect(rows.outbox).toEqual([
      { action: 'send_email', subject_type: 'notification_email', subject_id: receipt.emailId, status: 'pending' },
    ]);
    expect(rows.email).toEqual([
      {
        to_email: 'tenant@example.com',
        from_name: '大安管理公司',
        subject: '繳租提醒',
        body_text: '本月租金尚未入帳',
        notification_id: receipt.notificationId,
        sent_at: null,
      },
    ]);
  });

  it('寫完 notify 後交易回滾：三張表都不留', async () => {
    await expect(
      inA(async (tx) => {
        await notify(tx, base({ email }));
        throw new Error('後面的步驟失敗');
      }),
    ).rejects.toThrow('後面的步驟失敗');
    expect(await counts()).toEqual({ notifications: 0, emails: 0, outbox: 0 });
  });

  it('只要站內通知：不寫 email 與 outbox', async () => {
    const receipt = await inA((tx) => notify(tx, base()));
    expect(receipt).toMatchObject({ emailId: null, outboxId: null });
    expect(await counts()).toEqual({ notifications: 1, emails: 0, outbox: 0 });
  });

  it('只要 email（inApp: false）：不寫站內通知，email 的主旨與本文預設取標題與內文', async () => {
    const receipt = await inA((tx) => notify(tx, base({ inApp: false, email: { to: 'a@example.com', from: '大安管理公司' } })));
    expect(receipt.notificationId).toBeNull();
    const row = await inA(async (tx) => (await tx.query(`SELECT subject, body_text, notification_id FROM org.notification_emails`)).rows[0]);
    expect(row).toEqual({ subject: '測試通知', body_text: '這是一則測試通知', notification_id: null });
    expect(await counts()).toEqual({ notifications: 0, emails: 1, outbox: 1 });
  });

  it.each([
    ['沒有任何通道', { inApp: false }],
    ['種類格式不合', { kind: 'Demo' }],
    ['標題為空', { title: ' ' }],
    ['站內連結是外部網址', { linkPath: 'https://evil.example.com' }],
    ['站內連結是 // 開頭', { linkPath: '//evil.example.com' }],
    ['收件人不是 email', { email: { ...email, to: 'nope' } }],
    ['寄件名義為空', { email: { ...email, from: ' ' } }],
    ['寄件名義含換行', { email: { ...email, from: '管理公司\nBcc: x@example.com' } }],
    ['收件成員不是 ULID', { recipientPartyId: 'not-a-ulid' }],
  ] as [string, Partial<NotifyInput>][])('輸入不合格丟 NotifyInputError，什麼都不寫：%s', async (_label, patch) => {
    await expect(inA((tx) => notify(tx, base(patch)))).rejects.toBeInstanceOf(NotifyInputError);
    expect(await counts()).toEqual({ notifications: 0, emails: 0, outbox: 0 });
  });

  it('站內通知只寫在呼叫者的組織：別的組織看不到', async () => {
    await inA((tx) => notify(tx, base({ email })));
    expect(await inOrg(kit.orgB, (tx) => listNotifications(tx, PARTY_1))).toEqual([]);
    expect(await inOrg(kit.orgB, (tx) => countUnread(tx, PARTY_1))).toBe(0);
  });
});

describe('通知清單、未讀數、標已讀', () => {
  it('清單新的在前，帶連結與未讀狀態；組織通知所有成員都看得到', async () => {
    await inA((tx) => notify(tx, base({ title: '第一則' })));
    await inA((tx) => notify(tx, base({ title: '第二則', linkPath: '/contracts/1' })));
    for (const party of [PARTY_1, PARTY_2]) {
      const list = await inA((tx) => listNotifications(tx, party));
      expect(list.map((n) => n.title)).toEqual(['第二則', '第一則']);
      expect(list[0]).toMatchObject({ linkPath: '/contracts/1', kind: 'demo.test', body: '這是一則測試通知', read: false });
      expect(await inA((tx) => countUnread(tx, party))).toBe(2);
    }
  });

  it('指定收件成員的通知只有那位成員看得到', async () => {
    await inA((tx) => notify(tx, base({ title: '給成員一', recipientPartyId: PARTY_1 })));
    expect((await inA((tx) => listNotifications(tx, PARTY_1))).map((n) => n.title)).toEqual(['給成員一']);
    expect(await inA((tx) => listNotifications(tx, PARTY_2))).toEqual([]);
    expect(await inA((tx) => countUnread(tx, PARTY_2))).toBe(0);
  });

  it('標已讀：未讀數減一、清單顯示已讀；重複標不出錯', async () => {
    const a = await inA((tx) => notify(tx, base({ title: 'A' })));
    await inA((tx) => notify(tx, base({ title: 'B' })));
    expect(await inA((tx) => markRead(tx, a.notificationId!, PARTY_1))).toBe(true);
    expect(await inA((tx) => markRead(tx, a.notificationId!, PARTY_1))).toBe(true);
    expect(await inA((tx) => countUnread(tx, PARTY_1))).toBe(1);
    const list = await inA((tx) => listNotifications(tx, PARTY_1));
    expect(list.map((n) => [n.title, n.read])).toEqual([
      ['B', false],
      ['A', true],
    ]);
  });

  it('只看未讀', async () => {
    const a = await inA((tx) => notify(tx, base({ title: 'A' })));
    await inA((tx) => notify(tx, base({ title: 'B' })));
    await inA((tx) => markRead(tx, a.notificationId!, PARTY_1));
    const unread = await inA((tx) => listNotifications(tx, PARTY_1, { unreadOnly: true }));
    expect(unread.map((n) => n.title)).toEqual(['B']);
  });

  it('別的組織的通知、別人的個人通知、不存在的 ID：標已讀都回 false 且不改資料', async () => {
    const own = await inA((tx) => notify(tx, base({ recipientPartyId: PARTY_1 })));
    expect(await inA((tx) => markRead(tx, own.notificationId!, PARTY_2))).toBe(false);
    expect(await inOrg(kit.orgB, (tx) => markRead(tx, own.notificationId!, PARTY_1))).toBe(false);
    expect(await inA((tx) => markRead(tx, newUlid(), PARTY_1))).toBe(false);
    expect(await inA((tx) => countUnread(tx, PARTY_1))).toBe(1);
  });

  it('全部標已讀：只動看得到的未讀，別人的個人通知不動', async () => {
    await inA((tx) => notify(tx, base({ title: '組織' })));
    await inA((tx) => notify(tx, base({ title: '成員一', recipientPartyId: PARTY_1 })));
    await inA((tx) => notify(tx, base({ title: '成員二', recipientPartyId: PARTY_2 })));
    expect(await inA((tx) => markAllRead(tx, PARTY_1))).toBe(2);
    expect(await inA((tx) => countUnread(tx, PARTY_1))).toBe(0);
    expect(await inA((tx) => countUnread(tx, PARTY_2))).toBe(1);
  });
});

describe('提交後派送 email', () => {
  const queue = (over: Partial<NotifyInput> = {}) => inA((tx) => notify(tx, base({ email, ...over })));

  it('派送成功：Mailer 收到信（含寄件名義與種類），email 列記下寄出時間，outbox 轉 done', async () => {
    const receipt = await queue();
    const result = await dispatchNotificationEmail(kit.orgA, receipt.outboxId!, deps());
    expect(result.kind).toBe('sent');
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({
      to: 'tenant@example.com',
      from: '大安管理公司',
      subject: '繳租提醒',
      text: '本月租金尚未入帳',
      kind: 'demo.test',
    });
    const rows = await inA(async (tx) => ({
      email: (await tx.query<{ sent_at: Date | null; mailer_message_id: string }>(`SELECT sent_at, mailer_message_id FROM org.notification_emails`)).rows[0],
      outbox: (await tx.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM org.outbox`)).rows[0],
    }));
    expect(rows.email.sent_at).toBeInstanceOf(Date);
    expect(rows.email.mailer_message_id).toBe((await mailer.listSent())[0].id);
    expect(rows.outbox).toEqual({ status: 'done', attempts: 1 });
  });

  it('同一列派送兩次只寄一封', async () => {
    const receipt = await queue();
    await dispatchNotificationEmail(kit.orgA, receipt.outboxId!, deps());
    const second = await dispatchNotificationEmail(kit.orgA, receipt.outboxId!, deps());
    expect(second.kind).toBe('skipped');
    expect(mailer.sent).toHaveLength(1);
  });

  it('交易回滾後 outbox 列不存在，派送什麼都不做', async () => {
    let outboxId: string | null = null;
    await expect(
      inA(async (tx) => {
        outboxId = (await notify(tx, base({ email }))).outboxId;
        throw new Error('回滾');
      }),
    ).rejects.toThrow();
    const result = await dispatchNotificationEmail(kit.orgA, outboxId!, deps());
    expect(result.kind).toBe('skipped');
    expect(mailer.sent).toHaveLength(0);
  });

  it('派送失敗：outbox 回 pending 並記錯誤，email 列沒有寄出時間', async () => {
    const receipt = await queue();
    mailer.failNext(new Error('smtp down'));
    const result = await dispatchNotificationEmail(kit.orgA, receipt.outboxId!, deps());
    expect(result).toMatchObject({ kind: 'failed', status: 'pending', error: 'smtp down' });
    const rows = await inA(async (tx) => ({
      email: (await tx.query<{ sent_at: Date | null }>(`SELECT sent_at FROM org.notification_emails`)).rows[0],
      outbox: (await tx.query<{ status: string; attempts: number; last_error: string }>(`SELECT status, attempts, last_error FROM org.outbox`)).rows[0],
    }));
    expect(rows.email.sent_at).toBeNull();
    expect(rows.outbox).toEqual({ status: 'pending', attempts: 1, last_error: 'smtp down' });
  });

  it('A 線的重試規則：首次之外再試 5 次，第 6 次失敗轉 dead，進人工處理清單', async () => {
    const receipt = await queue();
    for (let i = 0; i <= OUTBOX_MAX_RETRIES; i++) {
      mailer.failNext(new Error(`fail ${i}`));
      const result = await dispatchNotificationEmail(kit.orgA, receipt.outboxId!, deps());
      expect(result).toMatchObject({ kind: 'failed', status: i < OUTBOX_MAX_RETRIES ? 'pending' : 'dead' });
    }
    const dead = await inA((tx) => listDeadOutbox(tx));
    expect(dead.map((r) => [r.id, r.attempts, r.lastError])).toEqual([
      [receipt.outboxId, OUTBOX_MAX_RETRIES + 1, `fail ${OUTBOX_MAX_RETRIES}`],
    ]);
    const again = await dispatchNotificationEmail(kit.orgA, receipt.outboxId!, deps());
    expect(again.kind).toBe('skipped');
    expect(mailer.sent).toHaveLength(0);
  });

  it('drain 重派到期的 pending 列，一列失敗不影響其他列', async () => {
    await queue({ title: 'A' });
    await queue({ title: 'B' });
    mailer.failNext();
    const first = await drainNotificationEmails(kit.orgA, 10, deps());
    expect(first.map((r) => r.kind).sort()).toEqual(['failed', 'sent']);
    const second = await drainNotificationEmails(kit.orgA, 10, deps());
    expect(second.map((r) => r.kind)).toEqual(['sent']);
    expect(mailer.sent).toHaveLength(2);
  });

  it('組織隔離：別的組織的 outbox 列派送不到', async () => {
    const receipt = await queue();
    const result = await dispatchNotificationEmail(kit.orgB, receipt.outboxId!, deps());
    expect(result.kind).toBe('skipped');
    expect(mailer.sent).toHaveLength(0);
  });

  it('簽署模組的 drain 不碰通知 email 的列，通知的 drain 也不碰簽署的列', async () => {
    const receipt = await queue();
    const signing = createSigningModule({
      provider: createMockProvider(),
      subscribers: {},
      files: createLocalFileStore(os.tmpdir()),
      db: {
        requestOrg: async () => ({ kind: 'org', orgId: kit.orgA }),
        inOrg: (ctx, fn) => withTx(ctx, fn),
        inControl: (fn) => withTx({ kind: 'control' }, fn),
      },
    });
    expect(await signing.drainOutbox(kit.orgA, 10)).toEqual([]);
    const status = () =>
      inA(async (tx) => (await tx.query<{ status: string }>(`SELECT status FROM org.outbox WHERE id = $1`, [receipt.outboxId])).rows[0].status);
    expect(await status()).toBe('pending');

    await inA((tx) =>
      tx.query(`INSERT INTO org.outbox (id, org_id, action, subject_type, subject_id) VALUES ($1, $2, 'void_sign_task', 'contract', $3)`, [
        newUlid(),
        kit.orgA,
        newUlid(),
      ]),
    );
    const drained = await drainNotificationEmails(kit.orgA, 10, deps());
    expect(drained.map((r) => r.kind)).toEqual(['sent']);
    const left = await inA((tx) => tx.query(`SELECT 1 FROM org.outbox WHERE action = 'void_sign_task' AND status = 'pending'`));
    expect(left.rows).toHaveLength(1);
  });

  it('不是通知 email 的 outbox 列：派送函式不認領', async () => {
    const id = newUlid();
    await inA((tx) =>
      tx.query(`INSERT INTO org.outbox (id, org_id, action, subject_type, subject_id) VALUES ($1, $2, 'void_sign_task', 'contract', $3)`, [
        id,
        kit.orgA,
        newUlid(),
      ]),
    );
    const result = await dispatchNotificationEmail(kit.orgA, id, deps());
    expect(result.kind).toBe('skipped');
    expect(await inA(async (tx) => (await tx.query<{ status: string }>(`SELECT status FROM org.outbox WHERE id = $1`, [id])).rows[0].status)).toBe('pending');
  });
});

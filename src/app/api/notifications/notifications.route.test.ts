import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listMockMail, setMailer } from '@/lib/mailer';
import { createMockMailer } from '@/lib/mailer/mock-mailer';
import { notify } from '@/lib/notifications';
import { withTx } from '@/lib/pg/database';
import { actAs, actAsError, actAsParty, setupRouteDb, TEST_PARTY_ID, type RouteDb } from '@/lib/pg/route-test-kit';
import { newUlid } from '@/lib/pg/ulid';
import { Unauthenticated } from '@/lib/request-context';
import { POST as demoNotify } from '../demo/notify/route';
import { POST as markOne } from './[id]/read/route';
import { GET as list } from './route';
import { POST as readAll } from './read-all/route';
import { GET as unreadCount } from './unread-count/route';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

// MIL-120：通知 route 的 response body。連線是 PGlite 的 app_rw，RLS 生效。請求脈絡的成員是 TEST_PARTY_ID。

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(async () => {
  await kit.reset();
  actAs(kit.orgA);
});
afterEach(() => setMailer(undefined));

const json = (res: Response) => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const seed = (orgId: string, title: string, recipientPartyId?: string) =>
  withTx({ kind: 'org', orgId }, async (tx) => (await notify(tx, { kind: 'demo.test', title, body: '內文', linkPath: '/contracts', recipientPartyId })).notificationId!);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const getList = (qs = '') => list(new NextRequest(`http://localhost/api/notifications${qs}`));

describe('GET /api/notifications', () => {
  it('沒有通知時回空清單與 0 個未讀', async () => {
    expect(await json(await getList())).toEqual({ data: { items: [], unread: 0 } });
  });

  it('新的在前，每則有完整欄位，日期是 ISO 字串；只看到自己組織的通知', async () => {
    await seed(kit.orgA, '第一則');
    await seed(kit.orgA, '第二則');
    await seed(kit.orgB, '別的組織');
    const { data } = await json(await getList());
    expect(data.unread).toBe(2);
    expect(data.items.map((n: { title: string }) => n.title)).toEqual(['第二則', '第一則']);
    expect(data.items[0]).toEqual({
      id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      kind: 'demo.test',
      title: '第二則',
      body: '內文',
      linkPath: '/contracts',
      createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      read: false,
    });
  });

  it('?unread=1 只回未讀，?limit= 限制筆數', async () => {
    const first = await seed(kit.orgA, 'A');
    await seed(kit.orgA, 'B');
    await seed(kit.orgA, 'C');
    await markOne(new NextRequest('http://localhost/x', { method: 'POST' }), ctx(first));
    expect((await json(await getList('?unread=1'))).data.items.map((n: { title: string }) => n.title)).toEqual(['C', 'B']);
    expect((await json(await getList('?limit=1'))).data.items).toHaveLength(1);
  });

  it('別的成員的個人通知不出現', async () => {
    await seed(kit.orgA, '給別人', newUlid());
    await seed(kit.orgA, '給自己', TEST_PARTY_ID);
    expect((await json(await getList())).data.items.map((n: { title: string }) => n.title)).toEqual(['給自己']);
  });

  it('沒登入回 401', async () => {
    actAsError(new Unauthenticated());
    expect((await getList()).status).toBe(401);
    expect((await unreadCount()).status).toBe(401);
  });

  it('不是組織身分回 403', async () => {
    actAsParty();
    expect((await getList()).status).toBe(403);
  });
});

describe('GET /api/notifications/unread-count', () => {
  it('回未讀數，標已讀後減少', async () => {
    const a = await seed(kit.orgA, 'A');
    await seed(kit.orgA, 'B');
    expect((await json(await unreadCount())).data).toEqual({ unread: 2 });
    await markOne(new NextRequest('http://localhost/x', { method: 'POST' }), ctx(a));
    expect((await json(await unreadCount())).data).toEqual({ unread: 1 });
  });
});

describe('POST /api/notifications/[id]/read', () => {
  const post = (id: string) => markOne(new NextRequest('http://localhost/x', { method: 'POST' }), ctx(id));

  it('標已讀回 200，清單顯示已讀；重複標仍回 200', async () => {
    const id = await seed(kit.orgA, 'A');
    expect((await post(id)).status).toBe(200);
    expect((await post(id)).status).toBe(200);
    expect((await json(await getList())).data.items[0].read).toBe(true);
  });

  it('別的組織的通知、別人的個人通知、不存在的 ID 都回同一個 404，資料不變', async () => {
    const other = await seed(kit.orgB, '別的組織');
    const personal = await seed(kit.orgA, '給別人', newUlid());
    const responses = [await post(other), await post(personal), await post(newUlid())];
    expect(responses.map((r) => r.status)).toEqual([404, 404, 404]);
    expect(await json(responses[0])).toEqual(await json(responses[2]));
    actAs(kit.orgB);
    expect((await json(await getList())).data.unread).toBe(1);
  });
});

describe('POST /api/notifications/read-all', () => {
  it('全部標已讀，回標了幾則；別的組織不受影響', async () => {
    await seed(kit.orgA, 'A');
    await seed(kit.orgA, 'B');
    await seed(kit.orgB, 'C');
    const res = await readAll();
    expect(await json(res)).toEqual({ data: { marked: 2 } });
    expect((await json(await getList())).data.unread).toBe(0);
    actAs(kit.orgB);
    expect((await json(await getList())).data.unread).toBe(1);
  });
});

describe('POST /api/demo/notify（只在 Mock 模式）', () => {
  const post = (body: unknown = {}) =>
    demoNotify(new NextRequest('http://localhost/api/demo/notify', { method: 'POST', body: JSON.stringify(body) }));

  it('Mock 模式：寫站內通知、提交後寄出，寄件紀錄查得到寄件名義', async () => {
    const subject = `示範通知 ${newUlid()}`;
    const res = await post({ title: subject, from: '大安管理公司', to: 'tenant@example.com' });
    expect(res.status).toBe(201);
    expect(await json(res)).toEqual({ data: { notificationId: expect.any(String), delivery: 'sent' } });
    expect((await json(await getList())).data.items[0].title).toBe(subject);
    const mails = await listMockMail();
    expect(mails?.[0]).toMatchObject({ subject, from: '大安管理公司', to: 'tenant@example.com', kind: 'demo.test' });
  });

  it('輸入不合格回 400，不留通知', async () => {
    expect((await post({ to: 'not-an-email' })).status).toBe(400);
    expect((await json(await getList())).data.unread).toBe(0);
  });

  it('不是 Mock 模式（換了別的 adapter）回 404，不寫任何東西', async () => {
    setMailer(createMockMailer());
    expect((await post()).status).toBe(404);
    expect((await json(await getList())).data.unread).toBe(0);
  });

  it('沒登入回 401', async () => {
    actAsError(new Unauthenticated());
    expect((await post()).status).toBe(401);
  });
});

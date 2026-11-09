import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pgliteDriver } from './drivers';
import { asRole, createTestDb, type TestDb } from './test-harness';
import { newUlid } from './ulid';
import { createWithTx, type OrgTx, type WithTx } from './with-tx';

// MIL-120：站內通知、通知 email 與 outbox 新動作。約束都從外部（app_rw）觀察。RLS 隔離由 rls-penetration.test.ts 涵蓋。

describe('通知相關的表', () => {
  let testDb: TestDb;
  let db: PGliteInterface;
  let withTx: WithTx;
  const orgA = newUlid();
  const orgB = newUlid();

  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(() => testDb.close());

  beforeEach(async () => {
    db = await testDb.fresh();
    withTx = createWithTx(pgliteDriver(db));
    await asRole(db, 'app_owner', async () => {
      await db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner'), ($2, 'B', 'owner')`, [orgA, orgB]);
    });
  });

  const inOrg = <T,>(orgId: string, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId }, fn);

  const insertNotification = (tx: OrgTx, orgId: string, over: { id?: string; kind?: string; linkPath?: string | null; party?: string | null } = {}) => {
    const id = over.id ?? newUlid();
    return tx
      .query(`INSERT INTO org.notifications (id, org_id, recipient_party_id, kind, title, body, link_path) VALUES ($1, $2, $3, $4, 't', 'b', $5)`, [
        id,
        orgId,
        over.party ?? null,
        over.kind ?? 'demo.test',
        over.linkPath ?? null,
      ])
      .then(() => id);
  };
  const insertEmail = (tx: OrgTx, orgId: string, notificationId: string | null, over: { to?: string; from?: string; subject?: string } = {}) =>
    tx.query(
      `INSERT INTO org.notification_emails (id, org_id, notification_id, kind, to_email, from_name, subject, body_text)
       VALUES ($1, $2, $3, 'demo.test', $4, $5, $6, 'b')`,
      [newUlid(), orgId, notificationId, over.to ?? 'a@example.com', over.from ?? '管理公司', over.subject ?? '主旨'],
    );

  it('通知種類必須是「領域.動作」', async () => {
    await expect(inOrg(orgA, (tx) => insertNotification(tx, orgA, { kind: 'DEMO' }))).rejects.toThrow(/check/i);
    await expect(inOrg(orgA, (tx) => insertNotification(tx, orgA, { kind: 'demo' }))).rejects.toThrow(/check/i);
  });

  it.each(['https://evil.example.com', '//evil.example.com', 'contracts/1', '/a b', '/a\\b'])('站內連結只收站內路徑：%s 被擋', async (linkPath) => {
    await expect(inOrg(orgA, (tx) => insertNotification(tx, orgA, { linkPath }))).rejects.toThrow(/check/i);
  });

  it('站內路徑與空連結可以寫入', async () => {
    await inOrg(orgA, (tx) => insertNotification(tx, orgA, { linkPath: '/contracts/1?tab=files' }));
    await inOrg(orgA, (tx) => insertNotification(tx, orgA, { linkPath: null }));
  });

  it('收件成員與已讀成員必須是 ULID', async () => {
    await expect(inOrg(orgA, (tx) => insertNotification(tx, orgA, { party: 'nobody' }))).rejects.toThrow(/check/i);
  });

  it('email 的收件人、寄件名義、主旨有格式檢查', async () => {
    await expect(inOrg(orgA, (tx) => insertEmail(tx, orgA, null, { to: 'bad' }))).rejects.toThrow(/check/i);
    await expect(inOrg(orgA, (tx) => insertEmail(tx, orgA, null, { from: ' ' }))).rejects.toThrow(/check/i);
    await expect(inOrg(orgA, (tx) => insertEmail(tx, orgA, null, { from: 'x\nBcc: y' }))).rejects.toThrow(/check/i);
    await expect(inOrg(orgA, (tx) => insertEmail(tx, orgA, null, { subject: 'x\r\ny' }))).rejects.toThrow(/check/i);
  });

  it('email 不能掛在別的組織的通知上（複合外鍵）', async () => {
    const notificationOfB = await inOrg(orgB, (tx) => insertNotification(tx, orgB));
    await expect(inOrg(orgA, (tx) => insertEmail(tx, orgA, notificationOfB))).rejects.toThrow(/foreign key/i);
  });

  it('同組織的通知可以掛 email；也可以不掛通知', async () => {
    const own = await inOrg(orgA, (tx) => insertNotification(tx, orgA));
    await inOrg(orgA, (tx) => insertEmail(tx, orgA, own));
    await inOrg(orgA, (tx) => insertEmail(tx, orgA, null));
  });

  it('outbox 接受 send_email，仍擋未知動作，舊動作不受影響', async () => {
    const insert = (action: string) =>
      inOrg(orgA, (tx) =>
        tx.query(`INSERT INTO org.outbox (id, org_id, action, subject_type, subject_id) VALUES ($1, $2, $3, 'x', $4)`, [newUlid(), orgA, action, newUlid()]),
      );
    await insert('send_email');
    await insert('void_sign_task');
    await insert('create_sign_task');
    await expect(insert('delete_everything')).rejects.toThrow(/check/i);
  });
});

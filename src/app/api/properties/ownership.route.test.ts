import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as deskDetail } from '@/app/api/desk/ownership/[id]/route';
import { POST as deskDecision } from '@/app/api/desk/ownership/[id]/decision/route';
import { GET as deskFile } from '@/app/api/desk/ownership/[id]/file/route';
import { GET as deskQueue } from '@/app/api/desk/queue/route';
import { resolveRequestContext } from '@/lib/auth/login-flow';
import {
  AWAITING_REVIEW_MESSAGE,
  HOLDER_MISMATCH_MESSAGE,
  KEY_MISMATCH_MESSAGE,
  REKEY_LOCKED_WHILE_PENDING_MESSAGE,
  VERIFIED_NOTE,
} from '@/lib/ownership/messages';
import { withTx } from '@/lib/pg/database';
import { actAs, actAsContext, nextAnchorKey } from '@/lib/pg/route-test-kit';
import { setupPracticeKit, type PracticeKit } from '@/lib/practice-entities/test-kit';
import { POST as postAnchorKey } from './[id]/anchor-key/route';
import { GET as getFile } from './[id]/ownership/file/route';
import { POST as postConsent } from './[id]/ownership/consent/route';
import { GET as getOwnership, POST as postOwnership } from './[id]/ownership/route';
import { GET as getOne } from './[id]/route';
import { GET as getList, POST as postProperty } from './route';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));
let kit: PracticeKit;
vi.mock('@/lib/file-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/file-store')>()),
  getFileStore: () => kit.store,
}));

// MIL-201：上傳謄本，平台在審核台核對所有權。主要 seam：route handler 直接呼叫，配 PGlite 與切換組織。
// 連線是 PGlite 的 app_rw。營運者用真實登入流程取得身分（PLATFORM_OPERATOR_EMAILS）。

beforeAll(async () => {
  kit = await setupPracticeKit();
});
afterAll(() => kit.close());
beforeEach(async () => {
  await kit.reset();
  actAs(kit.kit.orgA);
});

const json = (res: Response) => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const PDF = new TextEncoder().encode('%PDF-1.7\n謄本內容');

async function createProperty(key = nextAnchorKey(), name = '大安區溫馨兩房'): Promise<string> {
  const res = await postProperty(
    new NextRequest('http://localhost/api/properties', {
      method: 'POST',
      body: JSON.stringify({ name, address: '台北市大安區和平東路二段 100 號 3 樓', equipment: [], anchor: { key } }),
    }),
  );
  expect(res.status).toBe(201);
  return (await json(res)).data.id;
}

const ownership = async (id: string) => json(await getOwnership(new NextRequest('http://localhost/x'), ctx(id)));
const consent = (id: string, decision: unknown = 'agree') =>
  postConsent(new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify({ decision }) }), ctx(id));

interface UploadOptions {
  claimedOwner?: string | null;
  acquiredAt?: string | null;
  file?: { bytes: Uint8Array; name: string; type: string } | null;
  trust?: Record<string, string> | null;
}
function uploadForm(options: UploadOptions = {}): FormData {
  const form = new FormData();
  const { claimedOwner = '王大明', acquiredAt = '2026-11-01', trust = null } = options;
  const file = options.file === undefined ? { bytes: PDF, name: '謄本.pdf', type: 'application/pdf' } : options.file;
  if (claimedOwner !== null) form.set('claimed_owner', claimedOwner);
  if (acquiredAt !== null) form.set('acquired_at', acquiredAt);
  if (file) form.set('file', new File([file.bytes as BlobPart], file.name, { type: file.type }));
  if (trust) {
    form.set('has_trust', 'true');
    for (const [k, v] of Object.entries(trust)) form.set(k, v);
  }
  return form;
}
const upload = (id: string, options: UploadOptions = {}) =>
  postOwnership(new NextRequest('http://localhost/x', { method: 'POST', body: uploadForm(options) }), ctx(id));

const TRUST = {
  trust_registered_owner: '王大明',
  trust_related_parties: '某某銀行',
  trust_registration_status: '信託登記中',
  trust_lease_clause: '受託人得出租',
};

/** 同意個資告知後上傳。 */
async function consentAndUpload(id: string, options: UploadOptions = {}) {
  expect((await consent(id)).status).toBe(200);
  const res = await upload(id, options);
  expect(res.status).toBe(201);
  return res;
}

async function actAsOperator() {
  const op = await kit.operatorAccount();
  actAsContext(await resolveRequestContext(op.token, new Date(Date.now() + 120_000), 'test'));
  return op;
}

const openItems = () => kit.kit.asOwner(async (db) => (await db.query<{ id: string; payload: Record<string, any> }>(`SELECT id, payload FROM registry.review_items WHERE type = 'leasing_authority' AND status = 'open' ORDER BY created_at`)).rows); // eslint-disable-line @typescript-eslint/no-explicit-any

const decide = (itemId: string, body: Record<string, unknown> = {}) =>
  deskDecision(
    new Request('http://localhost/x', {
      method: 'POST',
      body: JSON.stringify({ key_match: true, holder_match: true, holder_masked: '王○明', reason: '謄本相符', ...body }),
    }),
    ctx(itemId),
  );

/** 以組織身分跑一段讀取。 */
const asOrg = <T>(orgId: string, fn: (tx: import('@/lib/pg/with-tx').OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId, partyId: '00000000000000000000000004' }, fn);
const notifications = (orgId: string) =>
  asOrg(orgId, async (tx) => (await tx.query<{ kind: string; title: string; body: string; link_path: string | null }>('SELECT kind, title, body, link_path FROM org.notifications ORDER BY id')).rows);
const audit = (orgId: string, action: string) =>
  asOrg(orgId, async (tx) =>
    (await tx.query<{ actor_type: string; actor_id: string | null; payload: Record<string, unknown> }>('SELECT actor_type, actor_id, payload FROM audit.events WHERE action = $1 ORDER BY seq', [action])).rows,
  );

describe('個資告知與上傳', () => {
  it('一開始沒有文件：待平台核對文件，能送出，還沒同意告知', async () => {
    const id = await createProperty();
    const { data } = await ownership(id);
    expect(data).toMatchObject({
      property_id: id,
      verification_status: 'pending_verification',
      node_status: null,
      submission: null,
      has_key: true,
      can_submit: true,
      verified_note: null,
      consent: { notice_type: 'transcript_id_pii', agreed: false },
    });
    expect(data.consent.text).toContain('蒐集目的');
  });

  it('沒有同意告知就上傳：403 consent_required，不寫檔，不建節點', async () => {
    const id = await createProperty();
    const res = await upload(id);
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ code: 'consent_required' });
    expect(kit.storeFiles()).toEqual([]);
    expect((await ownership(id)).data.node_status).toBeNull();
  });

  it('反對告知後仍不能上傳', async () => {
    const id = await createProperty();
    expect((await consent(id, 'object')).status).toBe(200);
    expect((await ownership(id)).data.consent.agreed).toBe(false);
    expect((await upload(id)).status).toBe(403);
  });

  it('同意以 recordConsent 記錄，並寫稽核事件', async () => {
    const id = await createProperty();
    expect((await (await consent(id)).json()).data.consent.agreed).toBe(true);
    const rows = await asOrg(kit.kit.orgA, async (tx) => (await tx.query('SELECT notice_type, decision, source FROM org.consent_records')).rows);
    expect(rows).toEqual([{ notice_type: 'transcript_id_pii', decision: 'agree', source: 'in_app' }]);
    expect((await audit(kit.kit.orgA, 'consent.record')).length).toBe(1);
  });

  it('決定只收 agree 或 object', async () => {
    const id = await createProperty();
    expect((await consent(id, 'yes')).status).toBe(400);
  });

  it('同意後上傳：201，節點待驗證，最新送件可讀，不能再送第二份，審核台排一個項目', async () => {
    const id = await createProperty();
    const res = await consentAndUpload(id);
    expect((await json(res)).data).toEqual({ id, verification_status: 'pending_verification', message: AWAITING_REVIEW_MESSAGE });

    const { data } = await ownership(id);
    expect(data).toMatchObject({
      verification_status: 'pending_verification',
      node_status: 'pending_verification',
      messages: [AWAITING_REVIEW_MESSAGE],
      can_submit: false,
      submission_count: 1,
      submission: { seq: 1, claimed_owner_name: '王大明', trust: null, file_name: '謄本.pdf', content_type: 'application/pdf' },
    });
    // 回應不含原檔的 key 與 SHA-256
    expect(JSON.stringify(data)).not.toMatch(/object_key|sha256|org\//);

    const again = await upload(id);
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ code: 'already_pending' });
    expect(kit.storeFiles()).toHaveLength(1);

    const items = await openItems();
    expect(items).toHaveLength(1);
    expect(items[0].payload).toMatchObject({ claimant_org_id: kit.kit.orgA });
    expect((await audit(kit.kit.orgA, 'ownership.submit')).length).toBe(1);
  });

  it('稽核事件不含姓名、檔名與建號', async () => {
    const id = await createProperty();
    await consentAndUpload(id);
    const [event] = await audit(kit.kit.orgA, 'ownership.submit');
    expect(Object.keys(event.payload).sort()).toEqual(['byte_size', 'has_trust', 'submission_id']);
    expect(JSON.stringify(event)).not.toMatch(/王大明|謄本\.pdf/);
  });

  it('物件列表與詳情的 verification_status 一致', async () => {
    const id = await createProperty();
    await consentAndUpload(id);
    expect((await json(await getOne(new NextRequest('http://localhost/x'), ctx(id)))).data.verification_status).toBe('pending_verification');
    expect((await json(await getList())).data.map((p: { verification_status: string }) => p.verification_status)).toEqual(['pending_verification']);
  });

  it.each([
    ['沒有所有權人', { claimedOwner: null }, 'claimedOwner'],
    ['沒有取得時間', { acquiredAt: null }, 'acquiredAt'],
    ['取得時間在未來', { acquiredAt: '2999-01-01' }, 'acquiredAt'],
    ['沒有檔案', { file: null }, 'file'],
    ['檔案不是 PDF 或圖片', { file: { bytes: new TextEncoder().encode('hello'), name: 'a.txt', type: 'text/plain' } }, 'file'],
  ] as const)('格式錯誤（%s）：400，不寫檔', async (_label, options, field) => {
    const id = await createProperty();
    expect((await consent(id)).status).toBe(200);
    const res = await upload(id, options as UploadOptions);
    expect(res.status).toBe(400);
    expect((await json(res)).field).toBe(field);
    expect(kit.storeFiles()).toEqual([]);
  });

  it('謄本顯示信託登記但缺出租權限條款：400 列出缺件，狀態不變，不寫檔', async () => {
    const id = await createProperty();
    expect((await consent(id)).status).toBe(200);
    const res = await upload(id, { trust: { ...TRUST, trust_lease_clause: '' } });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ code: 'trust_incomplete', field: 'trust', missing: ['leaseClause'] });
    expect(kit.storeFiles()).toEqual([]);
    expect((await ownership(id)).data.node_status).toBeNull();
  });

  it('信託四項齊全：存進送件', async () => {
    const id = await createProperty();
    await consentAndUpload(id, { trust: TRUST });
    expect((await ownership(id)).data.submission.trust).toEqual({
      registered_owner: '王大明',
      related_parties: '某某銀行',
      registration_status: '信託登記中',
      lease_clause: '受託人得出租',
    });
  });

  it('別的組織與不存在的物件：回應逐位元相同', async () => {
    const id = await createProperty();
    actAs(kit.kit.orgB);
    const probe = async (target: string) => {
      const results = [await getOwnership(new NextRequest('http://localhost/x'), ctx(target)), await upload(target), await consent(target), await getFile(new NextRequest('http://localhost/x'), ctx(target))];
      return Promise.all(results.map(async (r) => ({ status: r.status, text: await r.text() })));
    };
    expect(await probe(id)).toEqual(await probe('01ARZ3NDEKTSV4RRFFQ69G5FAV'));
    expect((await probe(id))[0].status).toBe(404);
  });
});

describe('審核台：項目、等待時間與原檔', () => {
  it('佇列列出出租權源項目：登錄方、鍵與段名，帶等待時間與是否逾時；不含所有權人與檔名', async () => {
    const id = await createProperty();
    await consentAndUpload(id, { claimedOwner: '極機密姓名' });
    await actAsOperator();
    const res = await deskQueue(new Request('http://localhost/api/desk/queue?status=open'));
    const text = await res.text();
    const item = JSON.parse(text).data.items.find((i: { type: string }) => i.type === 'leasing_authority');
    expect(item).toMatchObject({
      status: 'open',
      overdue: false,
      waitingMs: expect.any(Number),
      waitingBusinessMs: expect.any(Number),
      summary: { claimantOrgName: 'A 組織', held: false, claimedKey: { cityCode: 'A', townCode: '02', sectionCode: '0021' } },
    });
    expect(text).not.toMatch(/極機密姓名|謄本\.pdf/);
  });

  it('超過 1 個工作日的項目被標出', async () => {
    const id = await createProperty();
    await consentAndUpload(id);
    // 排進佇列的時間改成 10 天前
    await kit.kit.asOwner((db) => db.query(`UPDATE registry.review_items SET created_at = now() - interval '10 days' WHERE type = 'leasing_authority'`));
    await actAsOperator();
    const item = (await json(await deskQueue(new Request('http://localhost/api/desk/queue')))).data.items.find((i: { type: string }) => i.type === 'leasing_authority');
    expect(item.overdue).toBe(true);
    expect(item.waitingBusinessMs).toBeGreaterThan(24 * 3600 * 1000);
  });

  it('詳情：鍵與段名、主張的所有權人、取得時間、信託四項、檔案路徑；沒有原檔的 key', async () => {
    const id = await createProperty();
    await consentAndUpload(id, { trust: TRUST });
    const [{ id: itemId }] = await openItems();
    await actAsOperator();
    const res = await deskDetail(new Request('http://localhost/x'), ctx(itemId));
    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data).toMatchObject({
      item: { id: itemId, type: 'leasing_authority', status: 'open', overdue: false, held: false },
      claimantOrgName: 'A 組織',
      claimedKeyNames: { cityName: '臺北市', townName: '大安區', sectionName: '龍泉' },
      node: { status: 'pending_verification', key_match: null, holder_match: null, holder_masked: null },
      submission: { claimed_owner_name: '王大明', trust: { lease_clause: '受託人得出租' } },
      fileUrl: `/api/desk/ownership/${itemId}/file`,
    });
    expect(JSON.stringify(data)).not.toMatch(/object_key|sha256/);
  });

  it('營運者開啟原檔：回原檔位元組，在登錄方的鏈寫稽核事件，行為者是營運者；每次各一筆', async () => {
    const id = await createProperty();
    await consentAndUpload(id);
    const [{ id: itemId }] = await openItems();
    const op = await actAsOperator();
    for (let i = 0; i < 2; i += 1) {
      const res = await deskFile(new Request('http://localhost/x'), ctx(itemId));
      expect(res.status).toBe(200);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
    }
    actAs(kit.kit.orgA);
    const events = await audit(kit.kit.orgA, 'vault.read');
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.actor_type === 'operator' && e.actor_id === op.userId)).toBe(true);
  });

  it('組織成員開啟原檔：寫稽核事件，行為者是該成員；每次各一筆', async () => {
    const id = await createProperty();
    await consentAndUpload(id);
    for (let i = 0; i < 2; i += 1) {
      const res = await getFile(new NextRequest('http://localhost/x'), ctx(id));
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
    }
    const events = await audit(kit.kit.orgA, 'vault.read');
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.actor_type === 'party' && e.payload.reader === 'member')).toBe(true);
  });

  it('別的組織的成員讀不到原檔，也不留事件', async () => {
    const id = await createProperty();
    await consentAndUpload(id);
    actAs(kit.kit.orgB);
    expect((await getFile(new NextRequest('http://localhost/x'), ctx(id))).status).toBe(404);
    expect(await audit(kit.kit.orgB, 'vault.read')).toEqual([]);
    expect(await audit(kit.kit.orgA, 'vault.read')).toEqual([]);
  });

  it('組織成員不能用審核台的 route；沒登入回 401', async () => {
    const id = await createProperty();
    await consentAndUpload(id);
    const [{ id: itemId }] = await openItems();
    expect((await deskDetail(new Request('http://localhost/x'), ctx(itemId))).status).toBe(403);
    expect((await deskFile(new Request('http://localhost/x'), ctx(itemId))).status).toBe(403);
    expect((await decide(itemId)).status).toBe(403);
    expect((await json(await decide(itemId))).error).toContain('營運者');
    const { actAsError } = await import('@/lib/pg/route-test-kit');
    const { Unauthenticated } = await import('@/lib/request-context');
    actAsError(new Unauthenticated());
    expect((await decide(itemId)).status).toBe(401);
  });
});

describe('審核台判定', () => {
  it('兩項都相符：已核對，說明文字固定，登錄的一方收到站內通知，記錄判定人', async () => {
    const id = await createProperty();
    await consentAndUpload(id);
    const [{ id: itemId }] = await openItems();
    const op = await actAsOperator();
    const res = await decide(itemId);
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ outcome: 'verified' });

    actAs(kit.kit.orgA);
    const { data } = await ownership(id);
    expect(data).toMatchObject({
      verification_status: 'verified',
      node_status: 'verified',
      messages: [VERIFIED_NOTE],
      verified_note: '平台已比對出租權源文件',
      holder_masked: '王○明',
      can_submit: false,
    });
    expect((await json(await getOne(new NextRequest('http://localhost/x'), ctx(id)))).data.verification_status).toBe('verified');
    expect(await notifications(kit.kit.orgA)).toEqual([
      { kind: 'property.verification_passed', title: '物件已通過文件核對', body: '平台已比對出租權源文件。現在可以建立案件。', link_path: `/properties/${id}` },
    ]);
    const events = await audit(kit.kit.orgA, 'rental_right.judge');
    expect(events).toEqual([{ actor_type: 'operator', actor_id: op.userId, payload: { outcome: 'verified', key_match: true, holder_match: true } }]);
    const decisions = await kit.kit.asOwner(async (db) => (await db.query<Record<string, unknown>>('SELECT decided_by, outcome, reason FROM registry.ownership_decisions')).rows);
    expect(decisions).toEqual([{ decided_by: op.userId, outcome: 'verified', reason: '謄本相符' }]);
  });

  it('判定人不能由 body 指定', async () => {
    const id = await createProperty();
    await consentAndUpload(id);
    const [{ id: itemId }] = await openItems();
    const op = await actAsOperator();
    expect((await decide(itemId, { decided_by: 'someone-else' })).status).toBe(200);
    const rows = await kit.kit.asOwner(async (db) => (await db.query<{ decided_by: string }>('SELECT decided_by FROM registry.ownership_decisions')).rows);
    expect(rows).toEqual([{ decided_by: op.userId }]);
  });

  it('建號不符：使用者看到「建號與你的謄本不符，請修正」，通知同文，對外狀態是文件不符', async () => {
    const id = await createProperty();
    await consentAndUpload(id);
    const [{ id: itemId }] = await openItems();
    await actAsOperator();
    expect((await json(await decide(itemId, { key_match: false }))).data).toEqual({ outcome: 'failed' });

    actAs(kit.kit.orgA);
    const { data } = await ownership(id);
    expect(data).toMatchObject({ verification_status: 'failed', node_status: 'failed', messages: [KEY_MISMATCH_MESSAGE], can_submit: true });
    expect(KEY_MISMATCH_MESSAGE).toBe('建號與你的謄本不符，請修正');
    const [note] = await notifications(kit.kit.orgA);
    expect(note).toMatchObject({ kind: 'property.verification_failed', link_path: `/properties/${id}` });
    expect(note.body).toContain(KEY_MISMATCH_MESSAGE);
  });

  it('登記名義人不符：使用者看到要補的文件，訊息不提到任何別人', async () => {
    const id = await createProperty();
    await consentAndUpload(id);
    const [{ id: itemId }] = await openItems();
    await actAsOperator();
    await decide(itemId, { holder_match: false });
    actAs(kit.kit.orgA);
    const { data } = await ownership(id);
    expect(data.messages).toEqual([HOLDER_MISMATCH_MESSAGE]);
    expect(JSON.stringify(data.messages)).not.toMatch(/別人|別的|其他/);
  });

  it('兩項都不符：兩則訊息依序列出', async () => {
    const id = await createProperty();
    await consentAndUpload(id);
    const [{ id: itemId }] = await openItems();
    await actAsOperator();
    await decide(itemId, { key_match: false, holder_match: false });
    actAs(kit.kit.orgA);
    expect((await ownership(id)).data.messages).toEqual([KEY_MISMATCH_MESSAGE, HOLDER_MISMATCH_MESSAGE]);
  });

  it('修正後重新送出：狀態回到待驗證，審核台再排一個項目', async () => {
    const id = await createProperty();
    await consentAndUpload(id);
    const [{ id: first }] = await openItems();
    await actAsOperator();
    await decide(first, { key_match: false });

    actAs(kit.kit.orgA);
    const fix = nextAnchorKey();
    const fixed = await postAnchorKey(new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify(fix) }), ctx(id));
    expect(fixed.status).toBe(200);
    expect((await json(fixed)).data).toMatchObject({ verification_status: 'failed' });
    const again = await upload(id);
    expect(again.status).toBe(201);
    const { data } = await ownership(id);
    expect(data).toMatchObject({ verification_status: 'pending_verification', node_status: 'pending_verification', submission_count: 2, submission: { seq: 2 } });
    const items = await openItems();
    expect(items).toHaveLength(1);
    expect(items[0].id).not.toBe(first);
  });

  it('判定的輸入檢查：布林值、遮罩的名義人、理由；已判定的項目 409；不存在 404', async () => {
    const id = await createProperty();
    await consentAndUpload(id);
    const [{ id: itemId }] = await openItems();
    await actAsOperator();
    expect((await decide(itemId, { key_match: 'true' })).status).toBe(400);
    expect((await decide(itemId, { holder_masked: 'A123456789' })).status).toBe(400);
    expect((await decide(itemId, { reason: '' })).status).toBe(400);
    expect((await decide('01ARZ3NDEKTSV4RRFFQ69G5FAV')).status).toBe(404);
    expect((await decide(itemId)).status).toBe(200);
    expect((await decide(itemId)).status).toBe(409);
  });
});

describe('核對中與通過核對後修正建號', () => {
  const rekey = (id: string, key = nextAnchorKey()) =>
    postAnchorKey(new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify(key) }), ctx(id));

  it('文件核對中：不能修正建號，409 review_in_progress', async () => {
    const id = await createProperty();
    await consentAndUpload(id);
    const res = await rekey(id);
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: REKEY_LOCKED_WHILE_PENDING_MESSAGE, code: 'review_in_progress' });
  });

  it('已核對：修正建號送審核台，鍵維持原樣，對外狀態仍是已核對', async () => {
    const key = nextAnchorKey();
    const id = await createProperty(key);
    await consentAndUpload(id);
    const [{ id: itemId }] = await openItems();
    await actAsOperator();
    await decide(itemId);

    actAs(kit.kit.orgA);
    const res = await rekey(id);
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ id, verification_status: 'verified', change_requested: true, anchor: { building_no: key.buildingNo.padStart(5, '0') } });
    const read = (await json(await getOne(new NextRequest('http://localhost/x'), ctx(id)))).data;
    expect(read.verification_status).toBe('verified');
    expect(read.anchor.building_no).toBe(key.buildingNo.padStart(5, '0'));

    await actAsOperator();
    const queue = (await json(await deskQueue(new Request('http://localhost/api/desk/queue')))).data.items;
    expect(queue.find((i: { type: string }) => i.type === 'anchor_rekey')).toMatchObject({ status: 'open', summary: { claimantOrgName: 'A 組織' } });
  });
});

describe('別的組織對同一個鍵', () => {
  const sameKey = nextAnchorKey();

  async function holdCase() {
    // A 先通過核對
    const a = await createProperty(sameKey, 'A 的物件');
    await consentAndUpload(a);
    const [{ id: aItem }] = await openItems();
    await actAsOperator();
    expect((await decide(aItem)).status).toBe(200);
    // B 登錄同一個鍵，上傳，兩項都相符
    actAs(kit.kit.orgB);
    const b = await createProperty(sameKey, 'B 的物件');
    await consentAndUpload(b);
    const bItem = (await openItems()).find((i) => i.payload.claimant_org_id === kit.kit.orgB)!.id;
    await actAsOperator();
    return { a, b, bItem };
  }

  it('項目停在待處理：營運者看到 held，節點不變，不通知，不寫判定事件', async () => {
    const { b, bItem } = await holdCase();
    const res = await decide(bItem);
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ outcome: 'held' });

    const detail = (await json(await deskDetail(new Request('http://localhost/x'), ctx(bItem)))).data;
    expect(detail.item).toMatchObject({ status: 'open', held: true });

    actAs(kit.kit.orgB);
    const { data } = await ownership(b);
    expect(data).toMatchObject({ verification_status: 'pending_verification', node_status: 'pending_verification', messages: [AWAITING_REVIEW_MESSAGE], checked_at: null, holder_masked: null });
    expect(await notifications(kit.kit.orgB)).toEqual([]);
    expect(await audit(kit.kit.orgB, 'rental_right.judge')).toEqual([]);
  });

  it('後來的一方在送件前後看到的內容，與沒有重複的使用者相同', async () => {
    // A 持有 sameKey
    await createProperty(sameKey, 'A 持有');
    // B 用不重複的鍵走完一遍（對照組），再用撞號的鍵走一遍
    actAs(kit.kit.orgB);
    const walk = async (key: ReturnType<typeof nextAnchorKey>) => {
      const id = await createProperty(key, 'B 的物件');
      const before = await ownership(id);
      const submitted = await json(await consentAndUpload(id));
      const after = await ownership(id);
      return { before, submitted, after };
    };
    const plain = await walk(nextAnchorKey());
    const clash = await walk(sameKey);

    // 略過每次不同的 ID 與時間
    // consent.agreed 是使用者個人的同意狀態（同一個使用者第二次走時已同意），也略過
    const shape = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => (/_at$|^id$|^property_id$|^agreed$/.test(k) ? '<x>' : x)));
    expect(shape(clash.before.data)).toEqual(shape(plain.before.data));
    expect(shape(clash.submitted)).toEqual(shape(plain.submitted));
    expect(shape(clash.after.data)).toEqual(shape(plain.after.data));
    expect(clash.after.data.verification_status).toBe('pending_verification');
  });
});

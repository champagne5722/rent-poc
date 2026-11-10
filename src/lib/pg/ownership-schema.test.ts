import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import seedJson from '../registry/section-code/seed.json';
import type { SectionCodeSeed } from '../registry/section-code/types';
import { PLATFORM_ORG_ID } from '../auth/config';
import { OWNERSHIP_STATUSES, nextOwnershipStatus, type OwnershipStatus } from '../ownership/status';
import { pgliteDriver } from './drivers';
import { asRole, createTestDb, type TestDb } from './test-harness';
import { newUlid } from './ulid';
import { createWithTx, type OrgTx, type WithTx } from './with-tx';

// MIL-201：所有權節點、謄本送件、判定、原檔讀取、通過核對後的修正建號。
// 一律以 app_rw 從外部觀察；看 registry 的列或改資料時才用 asRole 換成 app_owner。

const seed = seedJson as SectionCodeSeed;
const plain = seed.sections.find((s) => !s.canceled && s.aliasTownCodes.length === 0)!;
const k = { city: plain.cityCode, town: plain.townCode, section: plain.code };

let testDb: TestDb;
let db: PGliteInterface;
let withTx: WithTx;
const orgA = newUlid();
const orgB = newUlid();
const partyA = newUlid();
const partyB = newUlid();
const operatorId = newUlid();
const outsiderId = newUlid();

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(() => testDb.close());

const owner = <T>(fn: () => Promise<T>) => asRole(db, 'app_owner', fn);

beforeEach(async () => {
  db = await testDb.fresh();
  withTx = createWithTx(pgliteDriver(db));
  await owner(async () => {
    await db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, '甲方', 'owner'), ($2, '乙方', 'owner')`, [orgA, orgB]);
    for (const [partyId, userId, name] of [
      [partyA, newUlid(), '甲方成員'],
      [partyB, newUlid(), '乙方成員'],
      [newUlid(), operatorId, '營運者'],
      [newUlid(), outsiderId, '外人'],
    ] as const) {
      await db.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, $2, $3)`, [partyId, `${partyId.toLowerCase()}@example.com`, name]);
      await db.query(`INSERT INTO control.users (id, party_id) VALUES ($1, $2)`, [userId, partyId]);
    }
    await db.query(`INSERT INTO control.org_memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, 'admin')`, [newUlid(), PLATFORM_ORG_ID, operatorId]);
  });
});

const asMember = <T>(orgId: string, partyId: string, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId, partyId }, fn);
const asA = <T>(fn: (tx: OrgTx) => Promise<T>) => asMember(orgA, partyA, fn);
const asB = <T>(fn: (tx: OrgTx) => Promise<T>) => asMember(orgB, partyB, fn);
/** 平台營運者進入登錄的一方的組織（ADR-0026 決議 7）。 */
const asOperatorIn = <T>(orgId: string, ticket: string, fn: (tx: OrgTx) => Promise<T>, id = operatorId) =>
  withTx({ kind: 'operator', operatorId: id, orgId, ticketId: ticket }, (tx) => fn(tx as OrgTx));
const asPlatform = <T>(fn: (tx: OrgTx) => Promise<T>) =>
  withTx({ kind: 'operator', operatorId, orgId: PLATFORM_ORG_ID, ticketId: 'desk:test' }, (tx) => fn(tx as OrgTx));

async function createProperty(orgId: string, partyId: string) {
  return withTx({ kind: 'org', orgId, partyId }, async (tx) => {
    const anchorId = newUlid();
    const unitId = newUlid();
    const propertyId = newUlid();
    await tx.query('SELECT * FROM registry.create_pending_anchor($1, $2, $3)', [anchorId, unitId, '某地址']);
    await tx.query('INSERT INTO org.properties (id, org_id, rental_unit_id, name, address) VALUES ($1, $2, $3, $4, $5)', [propertyId, orgId, unitId, '物件', '某地址']);
    return { anchorId, unitId, propertyId };
  });
}

async function setKey(orgId: string, partyId: string, anchorId: string, building: string) {
  const { rows } = await withTx({ kind: 'org', orgId, partyId }, (tx) =>
    tx.query<{ outcome: string }>('SELECT * FROM registry.assign_anchor_key($1, $2, $3, $4, $5, NULL, $6, $7)', [anchorId, k.city, k.town, k.section, building, newUlid(), newUlid()]),
  );
  return rows[0].outcome;
}

/** 組織建物件並填建號。 */
async function propertyWithKey(orgId: string, partyId: string, building = '1234') {
  const p = await createProperty(orgId, partyId);
  expect(await setKey(orgId, partyId, p.anchorId, building)).toMatch(/keyed|collision_queued/);
  return p;
}

interface SubmitRow {
  outcome: string;
  node_id: string;
  submission_id: string | null;
  status: string;
}

async function submit(tx: OrgTx, anchorId: string, over: Partial<{ nodeId: string; subId: string; itemId: string; owner: string; trust: boolean; acquiredAt: Date; orgId: string }> = {}) {
  const subId = over.subId ?? newUlid();
  const orgId = over.orgId ?? orgA;
  const { rows } = await tx.query<SubmitRow>(
    'SELECT * FROM registry.submit_ownership_transcript($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)',
    [
      anchorId,
      over.nodeId ?? newUlid(),
      subId,
      over.itemId ?? newUlid(),
      over.owner ?? '王大明',
      over.acquiredAt ?? new Date('2026-11-09T00:00:00Z'),
      over.trust ?? false,
      over.trust ? '王大明' : null,
      over.trust ? '某某銀行' : null,
      over.trust ? '信託登記中' : null,
      over.trust ? '受託人得出租' : null,
      `org/${orgId}/transcripts/${subId}.pdf`,
      'a'.repeat(64),
      1234,
      'application/pdf',
      '謄本.pdf',
    ],
  );
  return rows[0];
}

const decide = (
  tx: OrgTx,
  itemId: string,
  over: Partial<{ keyMatch: boolean; holderMatch: boolean; masked: string; reason: string }> = {},
) =>
  tx.query<{ outcome: string; node_id: string | null; property_id: string | null; status: string | null }>(
    'SELECT * FROM registry.decide_ownership_check($1, $2, $3, $4, $5, $6)',
    [itemId, over.keyMatch ?? true, over.holderMatch ?? true, over.masked ?? '王○明', over.reason ?? '謄本相符', newUlid()],
  );

const items = (sql = '') => owner(async () => (await db.query<Record<string, any>>(`SELECT * FROM registry.review_items ${sql}`)).rows); // eslint-disable-line @typescript-eslint/no-explicit-any
const nodeRows = (orgId: string, partyId: string) => asMember(orgId, partyId, async (tx) => (await tx.query<Record<string, any>>('SELECT * FROM org.ownership_nodes ORDER BY created_at, id')).rows); // eslint-disable-line @typescript-eslint/no-explicit-any

/** A 送出謄本，回傳節點與項目。 */
async function submitted(over: Parameters<typeof submit>[2] = {}) {
  const p = await propertyWithKey(orgA, partyA);
  const itemId = newUlid();
  const r = await asA((tx) => submit(tx, p.anchorId, { ...over, itemId }));
  expect(r.outcome).toBe('submitted');
  return { ...p, itemId, nodeId: r.node_id, subId: r.submission_id! };
}

describe('registry.submit_ownership_transcript', () => {
  it('建立待驗證節點、送件與一張出租權源項目，項目存送件當下的鍵', async () => {
    const s = await submitted();
    expect(await nodeRows(orgA, partyA)).toEqual([
      expect.objectContaining({ id: s.nodeId, org_id: orgA, anchor_id: s.anchorId, status: 'pending_verification', key_match: null, holder_match: null, holder_masked: null, current_submission_id: s.subId }),
    ]);
    const open = await items(`WHERE type = 'leasing_authority'`);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id: s.itemId, subject_type: 'ownership_node', subject_id: s.nodeId, status: 'open' });
    expect(open[0].payload).toEqual({
      claimant_org_id: orgA,
      submission_id: s.subId,
      claimed_key: { city_code: k.city, town_code: k.town, section_code: k.section, building_no: '01234', sub_no: '000' },
    });
  });

  it('信託登記：四項資料存進送件', async () => {
    const s = await submitted({ trust: true });
    const { rows } = await asA((tx) => tx.query('SELECT has_trust, trust_registered_owner, trust_lease_clause FROM org.ownership_submissions WHERE id = $1', [s.subId]));
    expect(rows).toEqual([{ has_trust: true, trust_registered_owner: '王大明', trust_lease_clause: '受託人得出租' }]);
  });

  it('同一個物件已有待核對的送件：回 already_pending，什麼都沒寫', async () => {
    const s = await submitted();
    const again = await asA((tx) => submit(tx, s.anchorId));
    expect(again).toMatchObject({ outcome: 'already_pending', node_id: s.nodeId, submission_id: null, status: 'pending_verification' });
    expect(await items(`WHERE type = 'leasing_authority'`)).toHaveLength(1);
    expect((await asA((tx) => tx.query('SELECT id FROM org.ownership_submissions'))).rows).toHaveLength(1);
  });

  it('物件還沒有建號：拒絕', async () => {
    const p = await createProperty(orgA, partyA);
    await expect(asA((tx) => submit(tx, p.anchorId))).rejects.toThrow(/還沒有建號/);
  });

  it('別的組織的物件與不存在的物件：錯誤完全相同', async () => {
    const p = await propertyWithKey(orgA, partyA);
    const probe = (anchorId: string) => asB((tx) => submit(tx, anchorId, { orgId: orgB })).then((r) => r, (e: Error & { code?: string }) => ({ code: e.code, message: e.message }));
    expect(await probe(p.anchorId)).toEqual(await probe(newUlid()));
    expect(await probe(p.anchorId)).toMatchObject({ code: 'P0002' });
  });

  it('營運者脈絡與沒有 party 的脈絡不能送件', async () => {
    const p = await propertyWithKey(orgA, partyA);
    await expect(asOperatorIn(orgA, 'desk:test', (tx) => submit(tx, p.anchorId))).rejects.toThrow(/必須由組織成員呼叫/);
    await expect(withTx({ kind: 'org', orgId: orgA }, (tx) => submit(tx, p.anchorId))).rejects.toThrow(/必須由組織成員呼叫/);
  });

  it('所有權人空白與未來的取得時間：拒絕', async () => {
    const p = await propertyWithKey(orgA, partyA);
    await expect(asA((tx) => submit(tx, p.anchorId, { owner: '  ' }))).rejects.toThrow(/所有權人不得為空/);
    await expect(asA((tx) => submit(tx, p.anchorId, { acquiredAt: new Date(Date.now() + 86_400_000) }))).rejects.toThrow(/取得時間/);
  });

  it('鍵撞到別的組織的使用者送件：流程與一般送件相同，項目存他自己宣稱的鍵', async () => {
    const first = await propertyWithKey(orgA, partyA, '2222');
    expect(first.anchorId).toBeTruthy();
    const second = await createProperty(orgB, partyB);
    expect(await setKey(orgB, partyB, second.anchorId, '2222')).toBe('collision_queued');
    const r = await asB((tx) => submit(tx, second.anchorId, { orgId: orgB }));
    expect(r.outcome).toBe('submitted');
    const claim = (await items(`WHERE type = 'leasing_authority'`))[0];
    expect(claim.payload.claimed_key.building_no).toBe('02222');
    expect(claim.payload.claimant_org_id).toBe(orgB);
  });
});

describe('registry.decide_ownership_check', () => {
  it('兩項都相符：節點轉已驗證，項目結案，判定人與理由記在判定紀錄', async () => {
    const s = await submitted();
    const r = await asOperatorIn(orgA, `desk:decide:${s.itemId}`, (tx) => decide(tx, s.itemId, { masked: '王○明', reason: '名義人相符' }));
    expect(r.rows[0]).toEqual({ outcome: 'verified', node_id: s.nodeId, property_id: s.propertyId, status: 'verified' });
    expect(await nodeRows(orgA, partyA)).toEqual([
      expect.objectContaining({ status: 'verified', key_match: true, holder_match: true, holder_masked: '王○明', checked_at: expect.any(Date) }),
    ]);
    expect((await items(`WHERE id = '${s.itemId}'`))[0]).toMatchObject({ status: 'resolved', resolution: 'match', resolved_by: operatorId });
    const decisions = await owner(async () => (await db.query<Record<string, any>>('SELECT * FROM registry.ownership_decisions')).rows); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(decisions).toEqual([expect.objectContaining({ item_id: s.itemId, org_id: orgA, outcome: 'verified', decided_by: operatorId, reason: '名義人相符', decided_at: expect.any(Date) })]);
    const keys = await owner(async () => (await db.query('SELECT org_id, building_no FROM registry.verified_ownership_keys')).rows);
    expect(keys).toEqual([{ org_id: orgA, building_no: '01234' }]);
  });

  it.each([
    [false, true],
    [true, false],
    [false, false],
  ])('建號 %s、名義人 %s：節點轉驗證失敗，兩項結果都記錄', async (keyMatch, holderMatch) => {
    const s = await submitted();
    const r = await asOperatorIn(orgA, 'desk:decide', (tx) => decide(tx, s.itemId, { keyMatch, holderMatch, reason: '不符' }));
    expect(r.rows[0]).toMatchObject({ outcome: 'failed', status: 'failed' });
    expect(await nodeRows(orgA, partyA)).toEqual([expect.objectContaining({ status: 'failed', key_match: keyMatch, holder_match: holderMatch })]);
    expect((await items(`WHERE id = '${s.itemId}'`))[0]).toMatchObject({ status: 'resolved', resolution: 'mismatch' });
    expect(await owner(async () => (await db.query('SELECT 1 FROM registry.verified_ownership_keys')).rows)).toEqual([]);
  });

  it('只有平台營運者能判定：組織成員與不是平台成員的營運者脈絡都被拒絕', async () => {
    const s = await submitted();
    await expect(asA((tx) => decide(tx, s.itemId))).rejects.toThrow(/只有平台營運者/);
    await expect(asOperatorIn(orgA, 'desk:decide', (tx) => decide(tx, s.itemId), outsiderId)).rejects.toThrow(/只有平台營運者/);
    expect((await nodeRows(orgA, partyA))[0].status).toBe('pending_verification');
  });

  it('判定人不能由呼叫者傳入：沒有對應的參數，紀錄的判定人一律是脈絡裡的營運者', async () => {
    const s = await submitted();
    const { rows } = await owner(() =>
      db.query<{ pronargs: number }>(`SELECT pronargs FROM pg_proc WHERE proname = 'decide_ownership_check' AND pronamespace = 'registry'::regnamespace`),
    );
    expect(rows[0].pronargs).toBe(6);
    await asOperatorIn(orgA, 'desk:decide', (tx) => decide(tx, s.itemId));
    expect((await owner(async () => (await db.query<{ decided_by: string }>('SELECT decided_by FROM registry.ownership_decisions')).rows))[0].decided_by).toBe(operatorId);
  });

  it('項目的登錄方不是目前脈絡的組織：拒絕', async () => {
    const s = await submitted();
    await expect(asOperatorIn(orgB, 'desk:decide', (tx) => decide(tx, s.itemId))).rejects.toThrow(/不屬於目前的組織/);
  });

  it('不存在的項目與已結案的項目', async () => {
    const s = await submitted();
    expect((await asOperatorIn(orgA, 'desk:decide', (tx) => decide(tx, newUlid()))).rows[0].outcome).toBe('not_found');
    await asOperatorIn(orgA, 'desk:decide', (tx) => decide(tx, s.itemId));
    expect((await asOperatorIn(orgA, 'desk:decide', (tx) => decide(tx, s.itemId))).rows[0].outcome).toBe('already_resolved');
  });

  it('遮罩的名義人與理由必填', async () => {
    const s = await submitted();
    await expect(asOperatorIn(orgA, 'desk:decide', (tx) => decide(tx, s.itemId, { masked: ' ' }))).rejects.toThrow(/判定需要/);
    await expect(asOperatorIn(orgA, 'desk:decide', (tx) => decide(tx, s.itemId, { reason: '' }))).rejects.toThrow(/判定需要/);
  });

  it('別的組織對同一個鍵已有已驗證的節點：項目停在待處理，節點與對外狀態不變，不寫組織表的任何結果', async () => {
    // A 先通過核對
    const a = await submitted();
    await asOperatorIn(orgA, 'desk:decide', (tx) => decide(tx, a.itemId));
    // B 撞同一個鍵，送件，兩項都相符
    const b = await createProperty(orgB, partyB);
    expect(await setKey(orgB, partyB, b.anchorId, '1234')).toBe('collision_queued');
    const bItem = newUlid();
    const sub = await asB((tx) => submit(tx, b.anchorId, { orgId: orgB, itemId: bItem }));
    const held = await asOperatorIn(orgB, 'desk:decide', (tx) => decide(tx, bItem));
    expect(held.rows[0]).toMatchObject({ outcome: 'held', node_id: sub.node_id, property_id: null, status: 'pending_verification' });

    // B 看到的節點與一般待驗證完全相同
    expect(await nodeRows(orgB, partyB)).toEqual([
      expect.objectContaining({ status: 'pending_verification', key_match: null, holder_match: null, holder_masked: null, checked_at: null }),
    ]);
    // 項目維持待處理，旗標只在營運者讀的項目 payload
    const item = (await items(`WHERE id = '${bItem}'`))[0];
    expect(item).toMatchObject({ status: 'open', resolution: null });
    expect(item.payload.held).toBe(true);
    // 判定紀錄有 held
    const outcomes = await owner(async () => (await db.query<{ outcome: string }>(`SELECT outcome FROM registry.ownership_decisions WHERE org_id = '${orgB}'`)).rows);
    expect(outcomes).toEqual([{ outcome: 'held' }]);
    // 已驗證的鍵只有 A 的
    expect(await owner(async () => (await db.query('SELECT org_id FROM registry.verified_ownership_keys')).rows)).toEqual([{ org_id: orgA }]);
  });

  it('同一個組織的判定不算衝突；別的鍵也不算衝突', async () => {
    const a = await submitted();
    await asOperatorIn(orgA, 'desk:decide', (tx) => decide(tx, a.itemId));
    const other = await propertyWithKey(orgB, partyB, '9999');
    const item = newUlid();
    await asB((tx) => submit(tx, other.anchorId, { orgId: orgB, itemId: item }));
    expect((await asOperatorIn(orgB, 'desk:decide', (tx) => decide(tx, item))).rows[0].outcome).toBe('verified');
  });

  it('驗證失敗後補件：節點回到待驗證，上一次的結果清掉，再送一張新項目', async () => {
    const s = await submitted();
    await asOperatorIn(orgA, 'desk:decide', (tx) => decide(tx, s.itemId, { keyMatch: false }));
    const again = await asA((tx) => submit(tx, s.anchorId));
    expect(again).toMatchObject({ outcome: 'submitted', node_id: s.nodeId, status: 'pending_verification' });
    expect(await nodeRows(orgA, partyA)).toEqual([
      expect.objectContaining({ status: 'pending_verification', key_match: null, holder_match: null, holder_masked: null, checked_at: null, current_submission_id: again.submission_id }),
    ]);
    expect((await asA((tx) => tx.query('SELECT seq FROM org.ownership_submissions ORDER BY seq'))).rows).toEqual([{ seq: 1 }, { seq: 2 }]);
    expect(await items(`WHERE type = 'leasing_authority' AND status = 'open'`)).toHaveLength(1);
  });

  it('已驗證的節點再送件：回 already_verified', async () => {
    const s = await submitted();
    await asOperatorIn(orgA, 'desk:decide', (tx) => decide(tx, s.itemId));
    expect(await asA((tx) => submit(tx, s.anchorId))).toMatchObject({ outcome: 'already_verified' });
  });
});

describe('審核台佇列與標頭', () => {
  it('佇列列出出租權源項目：登錄方名稱、鍵與段名、是否停住；不含所有權人與謄本內容', async () => {
    const s = await submitted({ owner: '極機密姓名' });
    const rows = await asPlatform(async (tx) => (await tx.query<Record<string, any>>(`SELECT * FROM registry.review_queue('open')`)).rows); // eslint-disable-line @typescript-eslint/no-explicit-any
    const row = rows.find((r) => r.id === s.itemId)!;
    expect(row).toMatchObject({ type: 'leasing_authority', subject_id: s.nodeId, status: 'open' });
    expect(row.summary).toMatchObject({ claimant_org_name: '甲方', held: false, claimed_key: { building_no: '01234' } });
    expect(row.summary.section_name).toBeTruthy();
    expect(JSON.stringify(row)).not.toMatch(/極機密姓名|謄本\.pdf/);
  });

  it('標頭給營運者組織 ID 與送件編號；非營運者拒絕', async () => {
    const s = await submitted();
    const head = await asPlatform(async (tx) => (await tx.query<{ h: Record<string, any> }>('SELECT registry.ownership_review_item($1) AS h', [s.itemId])).rows[0].h); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(head).toMatchObject({ id: s.itemId, type: 'leasing_authority', claimant_org_id: orgA, claimant_org_name: '甲方', submission_id: s.subId, held: false });
    await expect(asA((tx) => tx.query('SELECT registry.ownership_review_item($1)', [s.itemId]))).rejects.toThrow(/只有平台營運者/);
  });
});

describe('組織表的權限', () => {
  it('app_rw 不能直接新增非待驗證的節點、不能更新或刪除節點', async () => {
    const p = await createProperty(orgA, partyA);
    await expect(
      asA((tx) =>
        tx.query(
          `INSERT INTO org.ownership_nodes (id, org_id, anchor_id, status, key_match, holder_match, holder_masked, checked_at)
           VALUES ($1, $2, $3, 'verified', true, true, '王○明', now())`,
          [newUlid(), orgA, p.anchorId],
        ),
      ),
    ).rejects.toThrow(/新增時必須是待驗證/);
    const s = await submitted();
    await expect(asA((tx) => tx.query(`UPDATE org.ownership_nodes SET status = 'verified' WHERE id = $1`, [s.nodeId]))).rejects.toThrow(/permission denied/);
    await expect(asA((tx) => tx.query('DELETE FROM org.ownership_nodes WHERE id = $1', [s.nodeId]))).rejects.toThrow(/permission denied/);
  });

  it('app_rw 讀不到原檔的 key 與 SHA-256，讀得到其餘欄位', async () => {
    const s = await submitted();
    await expect(asA((tx) => tx.query('SELECT object_key FROM org.ownership_submissions'))).rejects.toThrow(/permission denied/);
    await expect(asA((tx) => tx.query('SELECT sha256 FROM org.ownership_submissions'))).rejects.toThrow(/permission denied/);
    await expect(asA((tx) => tx.query('SELECT * FROM org.ownership_submissions'))).rejects.toThrow(/permission denied/);
    const { rows } = await asA((tx) => tx.query('SELECT id, claimed_owner_name, file_name FROM org.ownership_submissions WHERE id = $1', [s.subId]));
    expect(rows).toEqual([{ id: s.subId, claimed_owner_name: '王大明', file_name: '謄本.pdf' }]);
  });

  it('送件只增不改', async () => {
    const s = await submitted();
    await expect(asA((tx) => tx.query(`UPDATE org.ownership_submissions SET claimed_owner_name = 'x' WHERE id = $1`, [s.subId]))).rejects.toThrow(/permission denied/);
    await expect(asA((tx) => tx.query('DELETE FROM org.ownership_submissions WHERE id = $1', [s.subId]))).rejects.toThrow(/permission denied/);
  });

  it('別的組織看不到節點與送件', async () => {
    await submitted();
    expect(await nodeRows(orgB, partyB)).toEqual([]);
    expect((await asB((tx) => tx.query('SELECT id FROM org.ownership_submissions'))).rows).toEqual([]);
  });

  it('registry 的判定紀錄與已驗證的鍵，app_rw 不能直接碰', async () => {
    for (const table of ['registry.ownership_decisions', 'registry.verified_ownership_keys']) {
      await expect(db.query(`SELECT * FROM ${table}`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`DELETE FROM ${table}`)).rejects.toThrow(/permission denied/);
    }
  });

  it('輔助函式沒有開放給 app_rw', async () => {
    await expect(db.query('SELECT registry.assert_platform_operator()')).rejects.toThrow(/permission denied/);
    await expect(db.query('SELECT * FROM registry.effective_anchor_key($1, $2)', [newUlid(), orgA])).rejects.toThrow(/permission denied/);
  });
});

describe('節點狀態轉移與 TypeScript 的轉移表一致', () => {
  it('每一組 (from, to)：資料庫接受的轉移，正好是純函式允許的轉移', async () => {
    const legal = new Set<string>();
    for (const from of OWNERSHIP_STATUSES) {
      for (const event of ['resubmit', 'verify', 'fail', 'lapse'] as const) {
        const to = nextOwnershipStatus(from, event);
        if (to) legal.add(`${from}>${to}`);
      }
    }
    const resultCols = (status: OwnershipStatus) =>
      status === 'pending_verification'
        ? { k: null, h: null, m: null, c: null }
        : status === 'failed'
          ? { k: false, h: true, m: '王○明', c: new Date() }
          : { k: true, h: true, m: '王○明', c: new Date() };
    for (const from of OWNERSHIP_STATUSES) {
      for (const to of OWNERSHIP_STATUSES) {
        if (from === to) continue;
        const p = await propertyWithKey(orgA, partyA, String(3000 + OWNERSHIP_STATUSES.indexOf(from) * 10 + OWNERSHIP_STATUSES.indexOf(to)));
        const nodeId = newUlid();
        const f = resultCols(from);
        const t = resultCols(to);
        await owner(async () => {
          // 擁有者在 FORCE RLS 下需要組織脈絡：用 set_config 設在這個連線上，測試結束即丟棄
          await db.query(`SELECT set_config('app.org_id', $1, false)`, [orgA]);
          await db.query(`INSERT INTO org.ownership_nodes (id, org_id, anchor_id) VALUES ($1, $2, $3)`, [nodeId, orgA, p.anchorId]);
          const set = (s: OwnershipStatus, c: typeof f) =>
            db.query(`UPDATE org.ownership_nodes SET status = $2, key_match = $3, holder_match = $4, holder_masked = $5, checked_at = $6 WHERE id = $1`, [nodeId, s, c.k, c.h, c.m, c.c]);
          if (from !== 'pending_verification') await set(from === 'lapsed' ? 'pending_verification' : from, from === 'lapsed' ? resultCols('pending_verification') : f);
          if (from === 'lapsed') await set('lapsed', resultCols('lapsed'));
        });
        let accepted = true;
        try {
          await owner(async () => {
            await db.query(`SELECT set_config('app.org_id', $1, false)`, [orgA]);
            await db.query(`UPDATE org.ownership_nodes SET status = $2, key_match = $3, holder_match = $4, holder_masked = $5, checked_at = $6 WHERE id = $1`, [nodeId, to, t.k, t.h, t.m, t.c]);
          });
        } catch (error) {
          if (!/不能從/.test((error as Error).message)) throw error;
          accepted = false;
        }
        expect({ from, to, accepted }).toEqual({ from, to, accepted: legal.has(`${from}>${to}`) });
      }
    }
  });
});

describe('org.read_ownership_file：原檔每次讀取都寫稽核事件', () => {
  // 事件寫在組織自己的鏈，組織脈絡用 org_read 政策讀得到。營運者讀取的事件也在登錄方的鏈
  const events = (orgId: string) =>
    withTx({ kind: 'org', orgId }, async (tx) =>
      (
        await tx.query<{ actor_type: string; actor_id: string | null; action: string; object_id: string; payload: Record<string, unknown> }>(
          `SELECT actor_type, actor_id, action, object_id, payload FROM audit.events WHERE action = 'vault.read' ORDER BY seq`,
        )
      ).rows,
    );

  it('組織成員讀：回 key，寫一筆事件，行為者是該成員', async () => {
    const s = await submitted();
    const { rows } = await asA((tx) => tx.query('SELECT * FROM org.read_ownership_file($1)', [s.subId]));
    expect(rows).toEqual([{ submission_id: s.subId, object_key: `org/${orgA}/transcripts/${s.subId}.pdf`, sha256: 'a'.repeat(64), content_type: 'application/pdf', file_name: '謄本.pdf' }]);
    expect(await events(orgA)).toEqual([{ actor_type: 'party', actor_id: partyA, action: 'vault.read', object_id: s.subId, payload: { node_id: s.nodeId, reader: 'member' } }]);
  });

  it('平台營運者讀：寫事件，行為者是營運者，鏈是登錄方組織', async () => {
    const s = await submitted();
    const { rows } = await asOperatorIn(orgA, `desk:file:${s.itemId}`, (tx) => tx.query('SELECT submission_id FROM org.read_ownership_file($1)', [s.subId]));
    expect(rows).toEqual([{ submission_id: s.subId }]);
    expect(await events(orgA)).toEqual([expect.objectContaining({ actor_type: 'operator', actor_id: operatorId, payload: { node_id: s.nodeId, reader: 'operator' } })]);
  });

  it('每次讀取各寫一筆', async () => {
    const s = await submitted();
    await asA((tx) => tx.query('SELECT * FROM org.read_ownership_file($1)', [s.subId]));
    await asA((tx) => tx.query('SELECT * FROM org.read_ownership_file($1)', [s.subId]));
    expect(await events(orgA)).toHaveLength(2);
  });

  it('別的組織與不存在的送件：0 列，沒有事件', async () => {
    const s = await submitted();
    expect((await asB((tx) => tx.query('SELECT * FROM org.read_ownership_file($1)', [s.subId]))).rows).toEqual([]);
    expect((await asB((tx) => tx.query('SELECT * FROM org.read_ownership_file($1)', [newUlid()]))).rows).toEqual([]);
    expect(await events(orgB)).toEqual([]);
    expect(await events(orgA)).toEqual([]);
  });

  it('不是平台成員的營運者脈絡與沒有 party 的脈絡：拒絕', async () => {
    const s = await submitted();
    await expect(asOperatorIn(orgA, 'desk:file', (tx) => tx.query('SELECT * FROM org.read_ownership_file($1)', [s.subId]), outsiderId)).rejects.toThrow(/只有平台營運者/);
    await expect(withTx({ kind: 'org', orgId: orgA }, (tx) => tx.query('SELECT * FROM org.read_ownership_file($1)', [s.subId]))).rejects.toThrow(/必須由組織成員或平台營運者呼叫/);
    expect(await events(orgA)).toEqual([]);
  });
});

describe('通過核對後修正建號', () => {
  const rekey = (orgId: string, partyId: string, anchorId: string, building: string, itemId = newUlid()) =>
    withTx({ kind: 'org', orgId, partyId }, (tx) =>
      tx.query<{ outcome: string }>('SELECT * FROM registry.assign_anchor_key($1, $2, $3, $4, $5, NULL, $6, $7)', [anchorId, k.city, k.town, k.section, building, itemId, newUlid()]),
    );

  it('核對中：不能修正，與已合併的物件同一種錯誤', async () => {
    const s = await submitted();
    await expect(rekey(orgA, partyA, s.anchorId, '7777')).rejects.toMatchObject({ code: '55000', message: '物件目前不能修正建號' });
  });

  it('驗證失敗後：能自行修正，立即生效', async () => {
    const s = await submitted();
    await asOperatorIn(orgA, 'desk:decide', (tx) => decide(tx, s.itemId, { keyMatch: false }));
    expect((await rekey(orgA, partyA, s.anchorId, '7777')).rows[0].outcome).toBe('keyed');
  });

  it('已驗證：不改鍵，排一張修正建號項目，回 rekey_queued', async () => {
    const s = await submitted();
    await asOperatorIn(orgA, 'desk:decide', (tx) => decide(tx, s.itemId));
    const r = await rekey(orgA, partyA, s.anchorId, '7777');
    expect(r.rows).toEqual([{ outcome: 'rekey_queued', item_id: null, property_id: null }]);
    const queued = await items(`WHERE type = 'anchor_rekey'`);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ subject_id: s.anchorId, status: 'open' });
    expect(queued[0].payload).toMatchObject({ claimant_org_id: orgA, claimed_key: { building_no: '07777' } });
    const anchor = await owner(async () => (await db.query(`SELECT building_no, status FROM registry.anchors WHERE id = '${s.anchorId}'`)).rows);
    expect(anchor).toEqual([{ building_no: '01234', status: 'keyed' }]);
  });

  it('已驗證：想改的鍵撞到別的組織，結果與沒撞到完全相同', async () => {
    const s = await submitted();
    await asOperatorIn(orgA, 'desk:decide', (tx) => decide(tx, s.itemId));
    await propertyWithKey(orgB, partyB, '5555');
    const taken = await rekey(orgA, partyA, s.anchorId, '5555');
    const free = await rekey(orgA, partyA, s.anchorId, '6666');
    expect(taken.rows).toEqual(free.rows);
    expect((await items(`WHERE type = 'anchor_rekey' AND status = 'open'`)).map((i) => i.payload.claimed_key.building_no)).toEqual(['06666']);
    expect(await items(`WHERE type = 'anchor_collision'`)).toEqual([]);
  });

  it('已驗證：改成目前的鍵，不排項目，回傳相同', async () => {
    const s = await submitted();
    await asOperatorIn(orgA, 'desk:decide', (tx) => decide(tx, s.itemId));
    expect((await rekey(orgA, partyA, s.anchorId, '1234')).rows).toEqual([{ outcome: 'rekey_queued', item_id: null, property_id: null }]);
    expect(await items(`WHERE type = 'anchor_rekey'`)).toEqual([]);
  });

  it('沒有節點的物件：照舊修正', async () => {
    const p = await propertyWithKey(orgA, partyA);
    expect((await rekey(orgA, partyA, p.anchorId, '4321')).rows[0].outcome).toBe('keyed');
  });
});

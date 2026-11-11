import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import seedJson from '../registry/section-code/seed.json';
import type { SectionCodeSeed } from '../registry/section-code/types';
import { PLATFORM_ORG_ID } from '../auth/config';
import { noticesFor } from '../ownership/conflict';
import { decideConflict, getConflict, insertContact, precheckConflict } from '../ownership/conflict-repository';
import { validateCheckForm } from '../ownership/forms';
import type { OwnershipConflictBasis, OwnershipConflictDecision } from '../types';
import { pgliteDriver } from './drivers';
import { asRole, createTestDb, type TestDb } from './test-harness';
import { newUlid } from './ulid';
import { createWithTx, type OrgTx, type WithTx } from './with-tx';

// MIL-208 資料段：兩方都通過核對時的衝突個案、聯絡紀錄、三種決定、建議鎖與稽核。
// 一律以 app_rw 從外部觀察；看 registry 的列或改資料時才用 asRole 換成 app_owner。
// 同時寫入的競態在 ownership-conflict.pg.test.ts（PGlite 只有一條連線）。後來的一方在衝突前後看到的輸出比對，
// 在 src/app/api/desk/ownership-conflict.route.test.ts。

const seed = seedJson as SectionCodeSeed;
const plain = seed.sections.find((s) => !s.canceled && s.aliasTownCodes.length === 0)!;
const k = { city: plain.cityCode, town: plain.townCode, section: plain.code };

let testDb: TestDb;
let db: PGliteInterface;
let withTx: WithTx;
const orgA = newUlid(); // 先前的一方
const orgB = newUlid(); // 後來的一方
const orgC = newUlid(); // 第三方
const partyA = newUlid();
const partyB = newUlid();
const partyC = newUlid();
const operatorId = newUlid();
const outsiderId = newUlid();

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(() => testDb.close());

const owner = <T>(fn: () => Promise<T>) => asRole(db, 'app_owner', fn);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const ownerRows = (sql: string, params: unknown[] = []) => owner(async () => (await db.query<Row>(sql, params)).rows);

beforeEach(async () => {
  db = await testDb.fresh();
  withTx = createWithTx(pgliteDriver(db));
  await owner(async () => {
    await db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, '甲方', 'owner'), ($2, '乙方', 'owner'), ($3, '丙方', 'owner')`, [orgA, orgB, orgC]);
    for (const [partyId, userId, name] of [
      [partyA, newUlid(), '甲方成員'],
      [partyB, newUlid(), '乙方成員'],
      [partyC, newUlid(), '丙方成員'],
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
const asC = <T>(fn: (tx: OrgTx) => Promise<T>) => asMember(orgC, partyC, fn);
const asOperatorIn = <T>(orgId: string, ticket: string, fn: (tx: OrgTx) => Promise<T>, id = operatorId) =>
  withTx({ kind: 'operator', operatorId: id, orgId, ticketId: ticket }, (tx) => fn(tx as OrgTx));
const asPlatform = <T>(fn: (tx: OrgTx) => Promise<T>, id = operatorId) => asOperatorIn(PLATFORM_ORG_ID, 'desk:test', fn, id);

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

async function submit(orgId: string, partyId: string, anchorId: string, itemId = newUlid()) {
  const subId = newUlid();
  const { rows } = await withTx({ kind: 'org', orgId, partyId }, (tx) =>
    tx.query<{ outcome: string; node_id: string }>(
      'SELECT * FROM registry.submit_ownership_transcript($1, $2, $3, $4, $5, $6, false, NULL, NULL, NULL, NULL, $7, $8, 1234, $9, $10)',
      [anchorId, newUlid(), subId, itemId, '王大明', new Date('2026-11-09T00:00:00Z'), `org/${orgId}/transcripts/${subId}.pdf`, 'a'.repeat(64), 'application/pdf', '謄本.pdf'],
    ),
  );
  return { itemId, subId, nodeId: rows[0].node_id };
}

const decideCheck = (tx: OrgTx, itemId: string, over: Partial<{ keyMatch: boolean; holderMatch: boolean; masked: string; reason: string }> = {}) =>
  tx.query<{ outcome: string; node_id: string | null; property_id: string | null; status: string | null }>('SELECT * FROM registry.decide_ownership_check($1, $2, $3, $4, $5, $6)', [
    itemId,
    over.keyMatch ?? true,
    over.holderMatch ?? true,
    over.masked ?? '王○明',
    over.reason ?? '謄本相符',
    newUlid(),
  ]);

const precheck = (tx: OrgTx, itemId: string, over: Partial<{ keyMatch: boolean; holderMatch: boolean; masked: string; reason: string }> = {}) =>
  precheckConflict(tx, itemId, { keyMatch: over.keyMatch ?? true, holderMatch: over.holderMatch ?? true, holderMasked: over.masked ?? '王○明', reason: over.reason ?? '謄本相符' }, newUlid());

const items = (sql = '') => ownerRows(`SELECT * FROM registry.review_items ${sql}`);
const nodeOf = (orgId: string, partyId: string, nodeId: string) =>
  asMember(orgId, partyId, async (tx) => (await tx.query<Row>('SELECT * FROM org.ownership_nodes WHERE id = $1', [nodeId])).rows[0]);
const keyRows = () => ownerRows('SELECT node_id, org_id, anchor_id, building_no, coexist_conflict_id FROM registry.verified_ownership_keys ORDER BY verified_at, node_id');
const conflictRows = () => ownerRows('SELECT * FROM registry.ownership_conflicts ORDER BY created_at');
const events = (orgId: string) =>
  withTx({ kind: 'org', orgId }, async (tx) => (await tx.query<Row>('SELECT actor_type, actor_id, action, object_type, object_id, payload FROM audit.events ORDER BY seq')).rows);
const notices = (orgId: string) => withTx({ kind: 'org', orgId }, async (tx) => (await tx.query<Row>('SELECT kind, title, body, link_path FROM org.notifications ORDER BY id')).rows);

/** 甲方先通過核對。 */
async function earlierVerified(building = '1234') {
  const p = await createProperty(orgA, partyA);
  expect(await setKey(orgA, partyA, p.anchorId, building)).toBe('keyed');
  const s = await submit(orgA, partyA, p.anchorId);
  expect((await asOperatorIn(orgA, `desk:decide:${s.itemId}`, (tx) => decideCheck(tx, s.itemId))).rows[0].outcome).toBe('verified');
  return { ...p, ...s };
}

/** 乙方登錄同一個鍵並送件，營運者判定兩項都相符，被停住。 */
async function laterHeld(building = '1234') {
  const first = await earlierVerified(building);
  const p = await createProperty(orgB, partyB);
  expect(await setKey(orgB, partyB, p.anchorId, building)).toBe('collision_queued');
  const s = await submit(orgB, partyB, p.anchorId);
  expect(await asPlatform((tx) => precheck(tx, s.itemId))).toBe('held');
  const conflictId = (await conflictRows())[0].id as string;
  return { first, later: { ...p, ...s }, conflictId };
}

async function decide(itemId: string, decision: OwnershipConflictDecision, basis: OwnershipConflictBasis | null = null, reason = '已聯絡雙方') {
  return asOperatorIn(orgB, `desk:decide:${itemId}`, (tx) => decideConflict(tx, itemId, { decision, reason, basis }, newUlid(), noticesFor(decision, basis)));
}

describe('衝突的偵測', () => {
  it('平台脈絡偵測：建立個案，判定紀錄是 held，項目旗標在 payload，後來的一方的鏈沒有任何事件', async () => {
    const { first, later, conflictId } = await laterHeld();
    const [c] = await conflictRows();
    expect(c).toMatchObject({
      id: conflictId,
      item_id: later.itemId,
      status: 'open',
      later_org_id: orgB,
      later_node_id: later.nodeId,
      later_submission_id: later.subId,
      earlier_org_id: orgA,
      earlier_node_id: first.nodeId,
      earlier_anchor_id: first.anchorId,
      earlier_submission_id: first.subId,
      earlier_holder_masked: '王○明',
      later_holder_masked: '王○明',
      building_no: '01234',
      decision: null,
    });
    expect((await items(`WHERE id = '${later.itemId}'`))[0]).toMatchObject({ status: 'open', resolution: null });
    expect((await items(`WHERE id = '${later.itemId}'`))[0].payload.held).toBe(true);
    expect(await ownerRows(`SELECT outcome FROM registry.ownership_decisions WHERE item_id = $1`, [later.itemId])).toEqual([{ outcome: 'held' }]);
    // 後來的一方的組織：沒有節點變化、沒有通知、鏈上除了它自己的送件事件（TypeScript 側寫，這裡沒有）外什麼都沒有
    expect((await nodeOf(orgB, partyB, later.nodeId)).status).toBe('pending_verification');
    expect(await events(orgB)).toEqual([]);
    expect(await notices(orgB)).toEqual([]);
    // 先前的一方：節點與鍵不變，鏈上只有它自己通過核對時的 operator.access
    expect((await nodeOf(orgA, partyA, first.nodeId)).status).toBe('verified');
    expect((await events(orgA)).map((e) => e.action)).toEqual(['operator.access']);
    expect(await notices(orgA)).toEqual([]);
    expect(await keyRows()).toEqual([expect.objectContaining({ node_id: first.nodeId, org_id: orgA, coexist_conflict_id: null })]);
    // 平台鏈有 ownership.conflict.open，payload 只有項目與雙方組織
    const platform = (await events(PLATFORM_ORG_ID)).filter((e) => e.action === 'ownership.conflict.open');
    expect(platform).toEqual([
      expect.objectContaining({ actor_type: 'operator', actor_id: operatorId, object_type: 'ownership_conflict', object_id: conflictId, payload: { item_id: later.itemId, later_org_id: orgB, earlier_org_id: orgA } }),
    ]);
  });

  it('同一個項目再偵測、再判定：回 held，不再寫判定紀錄或個案', async () => {
    const { later } = await laterHeld();
    expect(await asPlatform((tx) => precheck(tx, later.itemId))).toBe('held');
    expect(await asPlatform((tx) => precheck(tx, later.itemId, { keyMatch: false }))).toBe('held');
    expect((await asOperatorIn(orgB, 'desk:decide', (tx) => decideCheck(tx, later.itemId))).rows[0]).toMatchObject({ outcome: 'held', property_id: null, status: 'pending_verification' });
    expect((await asOperatorIn(orgB, 'desk:decide', (tx) => decideCheck(tx, later.itemId, { keyMatch: false }))).rows[0].outcome).toBe('held');
    expect(await ownerRows(`SELECT 1 FROM registry.ownership_decisions WHERE item_id = $1`, [later.itemId])).toHaveLength(1);
    expect(await conflictRows()).toHaveLength(1);
  });

  it('兩個交易之間的競態：沒有先偵測，直接判定也會建立個案（回 held，節點不變）', async () => {
    await earlierVerified();
    const p = await createProperty(orgB, partyB);
    await setKey(orgB, partyB, p.anchorId, '1234');
    const s = await submit(orgB, partyB, p.anchorId);
    const r = await asOperatorIn(orgB, `desk:decide:${s.itemId}`, (tx) => decideCheck(tx, s.itemId));
    expect(r.rows[0]).toMatchObject({ outcome: 'held', node_id: s.nodeId, property_id: null, status: 'pending_verification' });
    expect(await conflictRows()).toEqual([expect.objectContaining({ item_id: s.itemId, later_org_id: orgB, earlier_org_id: orgA })]);
    expect((await nodeOf(orgB, partyB, s.nodeId)).status).toBe('pending_verification');
  });

  it('沒有先通過的一方、兩項不全相符、同一個組織：都回 clear，什麼都不寫', async () => {
    const p = await createProperty(orgB, partyB);
    await setKey(orgB, partyB, p.anchorId, '4321');
    const s = await submit(orgB, partyB, p.anchorId);
    expect(await asPlatform((tx) => precheck(tx, s.itemId))).toBe('clear');
    expect(await asPlatform((tx) => precheck(tx, newUlid()))).toBe('clear');
    await earlierVerified('1234');
    const q = await createProperty(orgB, partyB);
    await setKey(orgB, partyB, q.anchorId, '1234');
    const t = await submit(orgB, partyB, q.anchorId);
    expect(await asPlatform((tx) => precheck(tx, t.itemId, { keyMatch: false }))).toBe('clear');
    expect(await asPlatform((tx) => precheck(tx, t.itemId, { holderMatch: false }))).toBe('clear');
    expect(await conflictRows()).toEqual([]);
    expect(await ownerRows(`SELECT 1 FROM registry.ownership_decisions WHERE item_id = $1`, [t.itemId])).toEqual([]);
  });

  it('只登錄建號、沒有交相符文件：不產生個案，也沒有可判定的項目（驗收 6）', async () => {
    await earlierVerified();
    const p = await createProperty(orgB, partyB);
    expect(await setKey(orgB, partyB, p.anchorId, '1234')).toBe('collision_queued');
    expect(await conflictRows()).toEqual([]);
    expect(await items(`WHERE type = 'leasing_authority' AND payload->>'claimant_org_id' = '${orgB}'`)).toEqual([]);
    // 只有送件但營運者判定不相符的人：也不產生個案
    const s = await submit(orgB, partyB, p.anchorId);
    expect((await asOperatorIn(orgB, 'desk:decide', (tx) => decideCheck(tx, s.itemId, { keyMatch: false }))).rows[0].outcome).toBe('failed');
    expect(await conflictRows()).toEqual([]);
  });

  it('偵測與記錄只有平台營運者：組織成員、非平台成員、營運者進入組織脈絡都被拒絕', async () => {
    const { later } = await laterHeld();
    await expect(asB((tx) => precheck(tx, later.itemId))).rejects.toThrow(/只有平台營運者/);
    await expect(asPlatform((tx) => precheck(tx, later.itemId), outsiderId)).rejects.toThrow(/只有平台營運者/);
    await expect(asOperatorIn(orgB, 'desk:x', (tx) => precheck(tx, later.itemId))).rejects.toThrow(/只有平台營運者/);
  });

  it('先前的一方失效後、鍵上沒有已驗證的節點：後來的一方判定通過', async () => {
    const { first, later } = await laterHeld();
    // 先前的一方的節點被別的入口失效並清除（共用函式 lapse_ownership_node）。這裡用 app_owner 模擬那個入口
    await owner(async () => {
      await db.query(`SELECT set_config('app.org_id', $1, false)`, [orgA]);
      await db.query('SELECT registry.lapse_ownership_node($1)', [first.nodeId]);
    });
    expect(await keyRows()).toEqual([]);
    // 項目有未決的個案，只能經 decide_ownership_conflict
    expect((await asOperatorIn(orgB, 'desk:decide', (tx) => decideCheck(tx, later.itemId))).rows[0].outcome).toBe('held');
    const r = await decide(later.itemId, 'later_prevails');
    expect(r).toEqual({ outcome: 'later_prevails', affectedCaseCount: 0 });
    expect(await keyRows()).toEqual([expect.objectContaining({ node_id: later.nodeId, org_id: orgB })]);
  });
});

describe('已驗證的鍵：同一個鍵不得有兩列，除非營運者決定並存', () => {
  it('app_owner 直接寫第二列也被擋下（唯一索引與觸發器）', async () => {
    const { first } = await laterHeld();
    const dup = (node: string, marker: string | null) =>
      owner(() =>
        db.query(
          `INSERT INTO registry.verified_ownership_keys (node_id, org_id, anchor_id, city_code, town_code, section_code, building_no, sub_no, coexist_conflict_id)
           SELECT $1, $2, anchor_id, city_code, town_code, section_code, building_no, sub_no, $3 FROM registry.verified_ownership_keys WHERE node_id = $4`,
          [node, orgB, marker, first.nodeId],
        ),
      );
    await expect(dup(newUlid(), null)).rejects.toThrow(/已有其他已驗證的節點/);
    // 標記必須指向「決定為並存」的個案：未決的個案不行，不存在的個案也不行
    const [c] = await conflictRows();
    await expect(dup(newUlid(), c.id)).rejects.toThrow(/並存的標記必須指向/);
    await expect(dup(newUlid(), newUlid())).rejects.toThrow();
    expect(await keyRows()).toHaveLength(1);
  });

  it('身分與鍵不得改，並存標記設定後不得改', async () => {
    const { first } = await laterHeld();
    await expect(owner(() => db.query(`UPDATE registry.verified_ownership_keys SET building_no = '09999' WHERE node_id = $1`, [first.nodeId]))).rejects.toThrow(/不得修改身分與鍵/);
  });
});

describe('遮罩的登記名義人：資料庫也擋證號', () => {
  const MASKED_CASES = ['王○明', '王O明', '  王○明  ', 'A123456789', '王A223456789', '身分證 B100000001', '123456', '12345', '統編12345678', 'a1', '', '   ', 'x'.repeat(40), 'x'.repeat(41), '王\u0007明', '王\n明', '王\t明'];

  it('SQL 的檢查與表單的檢查結果相同（同一組輸入）', async () => {
    for (const value of MASKED_CASES) {
      const form = validateCheckForm({ keyMatch: true, holderMatch: true, holderMasked: value, reason: 'x' });
      // 表單先 trim 再檢查，資料庫收到的是 trim 後的值。拒絕的案例用原值比對
      const forDb = form.ok ? form.value.holderMasked : value;
      const { rows } = await ownerRows('SELECT registry.holder_masked_acceptable($1) AS ok', [forDb]).then((r) => ({ rows: r }));
      expect({ value, db: rows[0].ok }).toEqual({ value, db: form.ok });
    }
  });

  it('偵測、判定函式都拒絕含證號的值（22023），什麼都不寫', async () => {
    await earlierVerified();
    const p = await createProperty(orgB, partyB);
    await setKey(orgB, partyB, p.anchorId, '1234');
    const s = await submit(orgB, partyB, p.anchorId);
    await expect(asPlatform((tx) => precheck(tx, s.itemId, { masked: 'A123456789' }))).rejects.toMatchObject({ code: '22023' });
    await expect(asOperatorIn(orgB, 'desk:decide', (tx) => decideCheck(tx, s.itemId, { masked: '統編12345678' }))).rejects.toMatchObject({ code: '22023' });
    expect(await ownerRows(`SELECT 1 FROM registry.ownership_decisions WHERE item_id = $1`, [s.itemId])).toEqual([]);
    expect(await conflictRows()).toEqual([]);
  });
});

describe('聯絡紀錄', () => {
  const contact = (itemId: string, over: Partial<{ target: 'earlier' | 'later'; channel: 'phone' | 'email' | 'other'; outcome: string; at: Date | null }> = {}, id = newUlid()) =>
    asPlatform((tx) => insertContact(tx, itemId, id, { target: over.target ?? 'earlier', channel: over.channel ?? 'phone', outcome: over.outcome ?? '已通話，對方說明取得經過', contactedAt: over.at ?? null }));

  it('記一筆：寫聯絡紀錄與平台鏈事件，事件沒有結果文字，任何一方的組織都沒有事件或通知', async () => {
    const { later, conflictId } = await laterHeld();
    const orgEventsBefore = [(await events(orgA)).length, (await events(orgB)).length];
    expect(await contact(later.itemId, { target: 'later', channel: 'email', outcome: '寄出說明信，等待回覆' })).toBe('recorded');
    expect(await ownerRows('SELECT target, channel, outcome, recorded_by FROM registry.ownership_contacts')).toEqual([
      { target: 'later', channel: 'email', outcome: '寄出說明信，等待回覆', recorded_by: operatorId },
    ]);
    const platform = (await events(PLATFORM_ORG_ID)).filter((e) => e.action === 'ownership.conflict.contact');
    expect(platform).toHaveLength(1);
    expect(platform[0]).toMatchObject({ actor_id: operatorId, object_id: conflictId });
    expect(Object.keys(platform[0].payload).sort()).toEqual(['channel', 'contact_id', 'target']);
    expect(JSON.stringify(platform[0])).not.toContain('寄出說明信');
    expect([(await events(orgA)).length, (await events(orgB)).length]).toEqual(orgEventsBefore);
    expect(await notices(orgA)).toEqual([]);
    expect(await notices(orgB)).toEqual([]);
  });

  it('時間：不得晚於現在，不得早於個案建立；可以指定過去的時間', async () => {
    const { later } = await laterHeld();
    await expect(contact(later.itemId, { at: new Date(Date.now() + 3_600_000) })).rejects.toMatchObject({ code: '22023' });
    await expect(contact(later.itemId, { at: new Date(Date.now() - 86_400_000) })).rejects.toMatchObject({ code: '22023' });
    const created = new Date((await conflictRows())[0].created_at as string | Date);
    expect(await contact(later.itemId, { at: new Date(created.getTime() + 1) })).toBe('recorded');
  });

  it('輸入不合格與沒有個案的項目', async () => {
    const { later } = await laterHeld();
    expect(await contact(newUlid())).toBe('not_found');
    await expect(contact(later.itemId, { outcome: '  ' })).rejects.toMatchObject({ code: '22023' });
    await expect(contact(later.itemId, { outcome: 'x'.repeat(501) })).rejects.toMatchObject({ code: '22023' });
    await expect(asPlatform((tx) => tx.query(`SELECT * FROM registry.record_ownership_contact($1, $2, 'both', 'phone', 'x', NULL)`, [later.itemId, newUlid()]))).rejects.toMatchObject({ code: '22023' });
    expect(await ownerRows('SELECT 1 FROM registry.ownership_contacts')).toEqual([]);
  });

  it('只有平台營運者能記；紀錄只增不改', async () => {
    const { later } = await laterHeld();
    await expect(asB((tx) => insertContact(tx, later.itemId, newUlid(), { target: 'later', channel: 'phone', outcome: 'x', contactedAt: null }))).rejects.toThrow(/只有平台營運者/);
    await expect(asPlatform((tx) => insertContact(tx, later.itemId, newUlid(), { target: 'later', channel: 'phone', outcome: 'x', contactedAt: null }), outsiderId)).rejects.toThrow(/只有平台營運者/);
    await contact(later.itemId);
    await expect(owner(() => db.query(`UPDATE registry.ownership_contacts SET outcome = 'y'`))).rejects.toThrow(/聯絡紀錄只增不改/);
    await expect(owner(() => db.query(`DELETE FROM registry.ownership_contacts`))).rejects.toThrow(/聯絡紀錄只增不改/);
  });

  it('決定之後仍可記聯絡（告知結果的電話）', async () => {
    const { later } = await laterHeld();
    await decide(later.itemId, 'later_rejected', 'holder_mismatch');
    expect(await contact(later.itemId, { target: 'later', outcome: '已告知結果' })).toBe('recorded');
  });
});

describe('並列讀取', () => {
  it('回雙方的組織、節點、送件、遮罩的名義人、鍵與聯絡；不含主張的所有權人與檔案 key', async () => {
    const { first, later } = await laterHeld();
    await asPlatform((tx) => insertContact(tx, later.itemId, newUlid(), { target: 'earlier', channel: 'phone', outcome: '通話', contactedAt: null }));
    const view = await asPlatform((tx) => getConflict(tx, later.itemId));
    expect(view).toMatchObject({
      status: 'open',
      decision: null,
      claimedKey: { cityCode: k.city, townCode: k.town, sectionCode: k.section, buildingNo: '01234', subNo: '000' },
      later: { orgId: orgB, orgName: '乙方', nodeId: later.nodeId, submissionId: later.subId, holderMasked: '王○明' },
      earlier: { orgId: orgA, orgName: '甲方', nodeId: first.nodeId, submissionId: first.subId, holderMasked: '王○明' },
    });
    expect(view!.earlier.verifiedAt).toEqual(expect.any(String));
    expect(view!.contacts).toEqual([expect.objectContaining({ target: 'earlier', channel: 'phone', outcome: '通話', recordedBy: operatorId })]);
    const raw = await asPlatform(async (tx) => (await tx.query<{ c: Row }>('SELECT registry.ownership_conflict_detail($1) AS c', [later.itemId])).rows[0].c);
    expect(JSON.stringify(raw)).not.toMatch(/王大明|object_key|sha256|謄本\.pdf/);
  });

  it('沒有個案的項目回 NULL；非平台營運者被拒', async () => {
    const { later } = await laterHeld();
    expect(await asPlatform((tx) => getConflict(tx, newUlid()))).toBeNull();
    await expect(asB((tx) => getConflict(tx, later.itemId))).rejects.toThrow(/只有平台營運者/);
    await expect(asOperatorIn(orgB, 'desk:x', (tx) => getConflict(tx, later.itemId))).rejects.toThrow(/只有平台營運者/);
  });

  it('項目標頭多 conflict_id 與 conflict_status，既有欄位不變', async () => {
    const { later, conflictId } = await laterHeld();
    const head = await asPlatform(async (tx) => (await tx.query<{ h: Row }>('SELECT registry.ownership_review_item($1) AS h', [later.itemId])).rows[0].h);
    expect(head).toMatchObject({ id: later.itemId, type: 'leasing_authority', held: true, claimant_org_id: orgB, conflict_id: conflictId, conflict_status: 'open' });
  });
});

describe('決定：後來的成立，先前的失效', () => {
  it('先前的節點轉已失效並清除鍵，後來的節點轉已驗證並寫入鍵；通知與事件各自獨立', async () => {
    const { first, later, conflictId } = await laterHeld();
    // 先前的一方有一個進行中的案件和一個已結案的案件：只算進行中
    await owner(async () => {
      await db.query(`SELECT set_config('app.org_id', $1, false)`, [orgA]);
      for (const state of ['active', 'closed']) {
        await db.query(`INSERT INTO org.cases (id, org_id, kind, state, business_type, rental_unit_id) VALUES ($1, $2, 'lease', $3, 'self_managed', $4)`, [newUlid(), orgA, state, first.unitId]);
      }
    });
    const r = await decide(later.itemId, 'later_prevails');
    expect(r).toEqual({ outcome: 'later_prevails', affectedCaseCount: 1 });

    expect((await nodeOf(orgA, partyA, first.nodeId)).status).toBe('lapsed');
    expect(await nodeOf(orgB, partyB, later.nodeId)).toMatchObject({ status: 'verified', key_match: true, holder_match: true, holder_masked: '王○明' });
    expect(await keyRows()).toEqual([expect.objectContaining({ node_id: later.nodeId, org_id: orgB, coexist_conflict_id: null })]);
    expect((await items(`WHERE id = '${later.itemId}'`))[0]).toMatchObject({ status: 'resolved', resolution: 'match', resolved_by: operatorId });
    expect((await conflictRows())[0]).toMatchObject({ id: conflictId, status: 'decided', decision: 'later_prevails', decision_reason: '已聯絡雙方', affected_case_count: 1, decided_by: operatorId });

    // 後來的一方：與一般判定通過相同的通知、事件
    expect(await notices(orgB)).toEqual([expect.objectContaining({ kind: 'property.verification_passed', link_path: `/properties/${later.propertyId}` })]);
    expect((await events(orgB)).map((e) => [e.action, e.actor_type])).toEqual([
      ['operator.access', 'operator'],
      ['rental_right.judge', 'operator'],
    ]);
    // 先前的一方：失效的通知與事件，文字不含另一方
    expect(await notices(orgA)).toEqual([expect.objectContaining({ kind: 'property.verification_lapsed', link_path: `/properties/${first.propertyId}` })]);
    const eventsA = await events(orgA);
    expect(eventsA.map((e) => e.action)).toEqual(['operator.access', 'operator.access', 'rental_right.revoke']);
    expect(eventsA[1].payload).toEqual({ ticket: `desk:lapse:${first.nodeId}` });
    expect(eventsA[2]).toMatchObject({ actor_type: 'operator', object_id: first.nodeId, payload: { outcome: 'lapsed' } });
    // 平台鏈
    const platform = (await events(PLATFORM_ORG_ID)).filter((e) => e.action === 'ownership.conflict.decide');
    expect(platform).toEqual([expect.objectContaining({ object_id: conflictId, payload: { item_id: later.itemId, decision: 'later_prevails', later_org_id: orgB, earlier_org_id: orgA, affected_case_count: 1 } })]);
  });

  it('先前的一方失效後能重新送件，與其他人一樣進入待核對', async () => {
    const { first, later } = await laterHeld();
    await decide(later.itemId, 'later_prevails');
    const again = await submit(orgA, partyA, first.anchorId);
    expect(again.nodeId).not.toBe(first.nodeId);
    expect((await nodeOf(orgA, partyA, again.nodeId)).status).toBe('pending_verification');
  });

  it('鍵有多個並存的節點時不支援讓後來的成立', async () => {
    const { later } = await laterHeld();
    await decide(later.itemId, 'coexist');
    const p = await createProperty(orgC, partyC);
    await setKey(orgC, partyC, p.anchorId, '1234');
    const s = await submit(orgC, partyC, p.anchorId);
    expect(await asPlatform((tx) => precheck(tx, s.itemId))).toBe('held');
    await expect(
      asOperatorIn(orgC, 'desk:decide', (tx) => decideConflict(tx, s.itemId, { decision: 'later_prevails', reason: 'x', basis: null }, newUlid(), noticesFor('later_prevails', null))),
    ).rejects.toMatchObject({ code: '0A000' });
    // 第三方可以加入並存
    const r = await asOperatorIn(orgC, 'desk:decide', (tx) => decideConflict(tx, s.itemId, { decision: 'coexist', reason: '三人共有', basis: null }, newUlid(), noticesFor('coexist', null)));
    expect(r.outcome).toBe('coexist');
    expect(await keyRows()).toHaveLength(3);
    expect((await keyRows()).every((r) => r.coexist_conflict_id !== null)).toBe(true);
    expect(new Set((await keyRows()).map((r) => r.coexist_conflict_id)).size).toBe(2);
  });
});

describe('決定：後來的不成立', () => {
  it.each([
    ['key_mismatch', false, true],
    ['holder_mismatch', true, false],
    ['both_mismatch', false, false],
  ] as const)('%s：走既有的驗證失敗路徑，節點記兩項比對，先前的一方完全不受影響', async (basis, keyMatch, holderMatch) => {
    const { first, later } = await laterHeld();
    const eventsA = await events(orgA);
    const r = await decide(later.itemId, 'later_rejected', basis);
    expect(r).toEqual({ outcome: 'later_rejected', affectedCaseCount: 0 });
    expect(await nodeOf(orgB, partyB, later.nodeId)).toMatchObject({ status: 'failed', key_match: keyMatch, holder_match: holderMatch, holder_masked: '王○明' });
    expect((await items(`WHERE id = '${later.itemId}'`))[0]).toMatchObject({ status: 'resolved', resolution: 'mismatch' });
    // 既有的固定訊息，沒有新訊息：通知與一般驗證失敗相同
    const [n] = await notices(orgB);
    expect(n.kind).toBe('property.verification_failed');
    expect(n.body).not.toMatch(/其他|別人|另一|已有|佔用|占用/);
    // 先前的一方：節點、鍵、鏈、通知都沒變
    expect((await nodeOf(orgA, partyA, first.nodeId)).status).toBe('verified');
    expect(await events(orgA)).toEqual(eventsA);
    expect(await notices(orgA)).toEqual([]);
    expect(await keyRows()).toEqual([expect.objectContaining({ node_id: first.nodeId })]);
  });

  it('不成立之後，後來的一方能照既有流程重新送件', async () => {
    const { later } = await laterHeld();
    await decide(later.itemId, 'later_rejected', 'holder_mismatch');
    const again = await submit(orgB, partyB, later.anchorId);
    expect(again.nodeId).toBe(later.nodeId);
    expect((await nodeOf(orgB, partyB, later.nodeId)).status).toBe('pending_verification');
  });
});

describe('決定：兩方並存', () => {
  it('兩方的鍵都標記並存，後來的錨點與整戶單位併入先前的；撞號項目結案；被合併的 ID 持續有效', async () => {
    const { first, later, conflictId } = await laterHeld();
    const r = await decide(later.itemId, 'coexist');
    expect(r).toEqual({ outcome: 'coexist', affectedCaseCount: 0 });
    expect((await nodeOf(orgA, partyA, first.nodeId)).status).toBe('verified');
    expect((await nodeOf(orgB, partyB, later.nodeId)).status).toBe('verified');
    expect(await keyRows()).toEqual([
      expect.objectContaining({ node_id: first.nodeId, coexist_conflict_id: conflictId }),
      expect.objectContaining({ node_id: later.nodeId, coexist_conflict_id: conflictId }),
    ]);
    expect(await ownerRows(`SELECT id, status, merged_into_id FROM registry.anchors WHERE id IN ($1, $2) ORDER BY status`, [first.anchorId, later.anchorId])).toEqual([
      { id: first.anchorId, status: 'keyed', merged_into_id: null },
      { id: later.anchorId, status: 'merged', merged_into_id: first.anchorId },
    ]);
    expect(await ownerRows(`SELECT id, status, merged_into_id FROM registry.rental_units WHERE id IN ($1, $2) ORDER BY status`, [first.unitId, later.unitId])).toEqual([
      { id: first.unitId, status: 'active', merged_into_id: null },
      { id: later.unitId, status: 'merged', merged_into_id: first.unitId },
    ]);
    expect((await items(`WHERE type = 'anchor_collision' AND subject_id = '${later.anchorId}'`))[0]).toMatchObject({ status: 'resolved', resolution: 'superseded' });
    // 兩方都收到一般的通過通知嗎：只有後來的一方收到（先前的一方不收到任何通知）
    expect((await notices(orgB)).map((n) => n.kind)).toEqual(['property.verification_passed']);
    expect(await notices(orgA)).toEqual([]);
    // 先前的一方的鏈沒有新事件
    expect((await events(orgA)).map((e) => e.action)).toEqual(['operator.access']);
  });

  it('後來的一方的鍵讀取經存續的錨點：物件仍顯示自己的鍵，解析函式走到存續的單位', async () => {
    const { first, later } = await laterHeld();
    await decide(later.itemId, 'coexist');
    const anchors = await asB(async (tx) => (await tx.query<Row>('SELECT * FROM registry.get_anchors_for_units($1::text[])', [[later.unitId]])).rows);
    expect(anchors).toEqual([expect.objectContaining({ unit_id: later.unitId, anchor_id: later.anchorId, status: 'keyed', building_no: '01234', city_code: k.city })]);
    const details = await asB(async (tx) => (await tx.query<Row>('SELECT * FROM registry.get_unit_details($1::text[])', [[later.unitId]])).rows);
    expect(details).toEqual([expect.objectContaining({ unit_id: later.unitId, display_unit_id: first.unitId, status: 'merged' })]);
    const groups = await asB(async (tx) => (await tx.query<Row>('SELECT * FROM registry.get_unit_groups($1::text[])', [[later.unitId]])).rows);
    const groupsA = await asA(async (tx) => (await tx.query<Row>('SELECT * FROM registry.get_unit_groups($1::text[])', [[first.unitId]])).rows);
    expect(groups[0].survivor_key).toBe(groupsA[0].survivor_key);
    expect(groups[0].group_key).toBe(groupsA[0].group_key);
  });

  it('兩方的營運資料各自隔離：物件、節點、通知、送件只看得到自己的', async () => {
    const { first, later } = await laterHeld();
    await decide(later.itemId, 'coexist');
    expect((await asA(async (tx) => (await tx.query<Row>('SELECT id, rental_unit_id FROM org.properties')).rows)).map((r) => r.id)).toEqual([first.propertyId]);
    expect((await asB(async (tx) => (await tx.query<Row>('SELECT id, rental_unit_id FROM org.properties')).rows)).map((r) => r.id)).toEqual([later.propertyId]);
    expect((await asA(async (tx) => (await tx.query<Row>('SELECT id FROM org.ownership_nodes')).rows)).map((r) => r.id)).toEqual([first.nodeId]);
    expect((await asB(async (tx) => (await tx.query<Row>('SELECT id FROM org.ownership_nodes')).rows)).map((r) => r.id)).toEqual([later.nodeId]);
    // 兩邊的單位列表：A 看不到 B 的單位，B 看不到 A 的單位
    expect(await asA(async (tx) => (await tx.query<Row>('SELECT * FROM registry.get_sibling_units($1)', [later.unitId])).rows)).toEqual([]);
    expect(await asB(async (tx) => (await tx.query<Row>('SELECT * FROM registry.get_sibling_units($1)', [first.unitId])).rows)).toEqual([]);
    expect(await asA(async (tx) => (await tx.query<Row>('SELECT * FROM registry.get_unit_details($1::text[])', [[later.unitId]])).rows)).toEqual([]);
    expect(await asB(async (tx) => (await tx.query<Row>('SELECT * FROM registry.get_anchors_for_units($1::text[])', [[first.unitId]])).rows)).toEqual([]);
  });

  it('分租單位的後綴：先前的一方新增分租單位，不受後來的一方的單位影響（合併不搬單位）', async () => {
    const { first, later } = await laterHeld();
    // 後來的一方先在自己的錨點加一個分租單位
    const subLater = await asB(async (tx) => (await tx.query<Row>('SELECT * FROM registry.create_sublet_unit($1, $2, $3, $4)', [later.unitId, newUlid(), '一號房', null])).rows[0]);
    expect(subLater.suffix).toBe('0001');
    await decide(later.itemId, 'coexist');
    const subEarlier = await asA(async (tx) => (await tx.query<Row>('SELECT * FROM registry.create_sublet_unit($1, $2, $3, $4)', [first.unitId, newUlid(), '甲房', null])).rows[0]);
    // 先前的一方新增的後綴是 0001：沒有因為後來的一方的單位而跳號
    expect(subEarlier.suffix).toBe('0001');
    // 後來的一方在合併之後不能再從被合併的整戶單位新增分租單位（create_sublet_unit 拒絕已合併的物件）
    await expect(asB((tx) => tx.query('SELECT * FROM registry.create_sublet_unit($1, $2, $3, $4)', [later.unitId, newUlid(), '二號房', null]))).rejects.toMatchObject({ code: '55000' });
  });
});

describe('決定的前提與權限', () => {
  it('只有平台營運者；個案的後來的一方必須是目前的組織', async () => {
    const { later } = await laterHeld();
    const call = (orgId: string, who = operatorId) =>
      asOperatorIn(orgId, 'desk:decide', (tx) => decideConflict(tx, later.itemId, { decision: 'coexist', reason: 'x', basis: null }, newUlid(), noticesFor('coexist', null)), who);
    await expect(asB((tx) => decideConflict(tx, later.itemId, { decision: 'coexist', reason: 'x', basis: null }, newUlid(), noticesFor('coexist', null)))).rejects.toThrow(/只有平台營運者/);
    await expect(call(orgB, outsiderId)).rejects.toThrow(/只有平台營運者/);
    await expect(call(orgA)).rejects.toThrow(/不屬於目前的組織/);
    expect((await conflictRows())[0].status).toBe('open');
  });

  it('輸入檢查：不支援的決定、少填或多填不符的項目、通知不合格', async () => {
    const { later } = await laterHeld();
    const raw = (decision: string, basis: string | null, later_notice: unknown, earlier_notice: unknown = null, reason = 'x') =>
      asOperatorIn(orgB, 'desk:decide', (tx) =>
        tx.query('SELECT * FROM registry.decide_ownership_conflict($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)', [later.itemId, decision, reason, basis, newUlid(), JSON.stringify(later_notice), earlier_notice === null ? null : JSON.stringify(earlier_notice)]),
      );
    const good = noticesFor('coexist', null).later;
    await expect(raw('merge', null, good)).rejects.toMatchObject({ code: '22023' });
    await expect(raw('later_rejected', null, noticesFor('later_rejected', 'key_mismatch').later)).rejects.toMatchObject({ code: '22023' });
    await expect(raw('coexist', 'key_mismatch', good)).rejects.toMatchObject({ code: '22023' });
    await expect(raw('coexist', null, good, noticesFor('later_prevails', null).earlier)).rejects.toMatchObject({ code: '22023' });
    await expect(raw('coexist', null, { ...good, kind: 'x.y' })).rejects.toMatchObject({ code: '22023' });
    await expect(raw('coexist', null, { ...good, body: '' })).rejects.toMatchObject({ code: '22023' });
    await expect(raw('later_prevails', null, noticesFor('later_prevails', null).later, null)).rejects.toMatchObject({ code: '22023' });
    await expect(raw('coexist', null, good, null, ' ')).rejects.toMatchObject({ code: '22023' });
    expect((await conflictRows())[0].status).toBe('open');
  });

  it('沒有個案的項目回 not_found；已決定的回 already_decided，不再改任何東西', async () => {
    const { later } = await laterHeld();
    expect(await asOperatorIn(orgB, 'desk:decide', (tx) => decideConflict(tx, newUlid(), { decision: 'coexist', reason: 'x', basis: null }, newUlid(), noticesFor('coexist', null)))).toEqual({ outcome: 'not_found', affectedCaseCount: 0 });
    await decide(later.itemId, 'later_rejected', 'key_mismatch');
    const businessEvents = async () => (await events(orgB)).filter((e) => e.action !== 'operator.access');
    const eventsB = await businessEvents();
    expect(await decide(later.itemId, 'coexist')).toEqual({ outcome: 'already_decided', affectedCaseCount: 0 });
    expect(await businessEvents()).toEqual(eventsB);
    expect((await conflictRows())[0]).toMatchObject({ decision: 'later_rejected', decision_basis: 'key_mismatch' });
  });

  it('已決定的個案不能改、不能刪', async () => {
    const { later } = await laterHeld();
    await decide(later.itemId, 'later_rejected', 'key_mismatch');
    await expect(owner(() => db.query(`UPDATE registry.ownership_conflicts SET decision_reason = 'z'`))).rejects.toThrow(/已決定的衝突個案不得修改/);
    await expect(owner(() => db.query(`DELETE FROM registry.ownership_conflicts`))).rejects.toThrow(/不得刪除/);
  });

  it('個案、聯絡、鍵：app_rw 不能直接碰；內部函式沒有開放給 app_rw', async () => {
    for (const table of ['registry.ownership_conflicts', 'registry.ownership_contacts']) {
      await expect(db.query(`SELECT * FROM ${table}`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`DELETE FROM ${table}`)).rejects.toThrow(/permission denied/);
    }
    for (const fn of ['registry.lapse_ownership_node($1)', 'registry.holder_masked_acceptable($1)', 'registry.ownership_key_lock($1, $1, $1, $1, $1)', 'registry.assert_conflict_notice(NULL, $1)']) {
      await expect(db.query(`SELECT ${fn}`, ['x'])).rejects.toThrow(/permission denied/);
    }
    await expect(db.query(`SELECT audit.append_platform_ownership_conflict('ownership.conflict.open', NULL, $1, '{}'::jsonb)`, [newUlid()])).rejects.toThrow(/permission denied/);
  });

  it('平台鏈的寫入口只收三個固定動作', async () => {
    await expect(
      owner(() => db.query(`SELECT audit.append_platform_ownership_conflict('ownership.conflict.other', NULL, $1, '{}'::jsonb)`, [newUlid()])),
    ).rejects.toThrow(/不支援的平台事件/);
  });
});

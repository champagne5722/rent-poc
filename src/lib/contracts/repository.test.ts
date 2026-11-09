import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendAudit } from '@/lib/audit';
import { withTx } from '@/lib/pg/database';
import { setupRouteDb, type RouteDb } from '@/lib/pg/route-test-kit';
import { newUlid } from '@/lib/pg/ulid';
import type { OrgTx } from '@/lib/pg/with-tx';
import { createProperty, parsePropertyInput } from '@/lib/properties';
import type { ContractFields, ContractStatus, LeaseContract } from '@/lib/types';
import {
  appendContractEvent,
  commitTransition,
  copyContractAsDraft,
  createContract,
  deleteDraftContract,
  getContract,
  getContractRelations,
  listContractEvents,
  listContracts,
  saveDraft,
} from './repository';

// 稽核寫入包一層，讓個別測試能讓它失敗，驗證「任一步失敗整筆回滾」
vi.mock('@/lib/audit', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/audit')>();
  return { ...original, appendAudit: vi.fn(original.appendAudit) };
});

// MIL-83：合約 repository 在 PGlite（app_rw，RLS 生效）上的行為。
// 衍生關聯的規則是 ADR-0006：撤回後複製記，拒簽後複製不記。

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(async () => {
  await kit.reset();
  vi.mocked(appendAudit).mockClear();
});

const inOrg = <T>(orgId: string, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId }, fn);
const inA = <T>(fn: (tx: OrgTx) => Promise<T>) => inOrg(kit.orgA, fn);

const FIELDS = { landlordName: '王大明', rent: 28000, routing: { businessType: 'self_managed', lesseeIsMasterLessor: false, brokerMediated: false } } as unknown as ContractFields;

async function newProperty(orgId: string): Promise<string> {
  const parsed = parsePropertyInput({ name: '物件', address: '台北市大安區某路 1 號', equipment: [] });
  if (!parsed.ok) throw new Error(parsed.error);
  return inOrg(orgId, (tx) => createProperty(tx, parsed.value));
}

async function seedContract(status: ContractStatus = 'draft', orgId = kit.orgA): Promise<string> {
  const propertyId = await newProperty(orgId);
  return inOrg(orgId, async (tx) => {
    const id = await createContract(tx, { property_id: propertyId, fields: FIELDS });
    if (status !== 'draft') await commitTransition(tx, id, { status, event: { type: 'voided', actor: 'landlord' } });
    return id;
  });
}

const auditActions = () =>
  inA(async (tx) => (await tx.query<{ action: string; object_id: string }>('SELECT action, object_id FROM audit.events ORDER BY seq')).rows);

describe('createContract', () => {
  it('建立草稿：ULID、物件、類型、欄位原樣讀回，並記「建立」歷程與稽核事件', async () => {
    const propertyId = await newProperty(kit.orgA);
    const id = await inA((tx) => createContract(tx, { property_id: propertyId, fields: FIELDS, contract_type: 'management' }));

    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const contract = await inA((tx) => getContract(tx, id));
    expect(contract).toEqual({
      id,
      property_id: propertyId,
      contract_type: 'management',
      status: 'draft',
      fields: FIELDS,
      signature_fields: [],
      declined_reason: null,
      derived_from: null,
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      updated_at: null,
    });
    const events = await inA((tx) => listContractEvents(tx, id));
    expect(events.map((e) => [e.type, e.actor, e.note])).toEqual([['created', 'landlord', null]]);
    expect((await auditActions()).filter((a) => a.action === 'contract.create')).toEqual([{ action: 'contract.create', object_id: id }]);
  });

  it('稽核 payload 只放物件 ID 與類型，不放姓名與租金', async () => {
    const id = await seedContract();
    const rows = await inA((tx) =>
      tx.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM audit.events WHERE action = 'contract.create' AND object_id = $1`, [id]),
    );
    expect(Object.keys(rows.rows[0].payload).sort()).toEqual(['contract_type', 'property_id']);
  });

  it('引用別的組織的物件：複合外鍵擋下，整筆回滾（沒有合約、沒有歷程、沒有稽核）', async () => {
    const bProperty = await newProperty(kit.orgB);
    await expect(inA((tx) => createContract(tx, { property_id: bProperty, fields: FIELDS }))).rejects.toThrow(/foreign key|violates/i);
    expect(await inA((tx) => listContracts(tx))).toEqual([]);
    expect(await auditActions()).toEqual([]);
  });

  it('稽核寫入失敗時，合約與歷程一起回滾', async () => {
    const propertyId = await newProperty(kit.orgA);
    const before = (await auditActions()).length;
    vi.mocked(appendAudit).mockRejectedValueOnce(new Error('稽核寫入失敗'));
    await expect(inA((tx) => createContract(tx, { property_id: propertyId, fields: FIELDS }))).rejects.toThrow('稽核寫入失敗');
    expect(await inA((tx) => listContracts(tx))).toEqual([]);
    expect(await kit.asOwner(async (db) => (await db.query('SELECT count(*)::int AS n FROM org.contract_events')).rows)).toEqual([{ n: 0 }]);
    expect((await auditActions()).length).toBe(before);
  });
});

describe('隔離', () => {
  it('別的組織的合約讀不到、列不出、改不到、複製不到、刪不到', async () => {
    const id = await seedContract('draft', kit.orgB);
    expect(await inA((tx) => getContract(tx, id))).toBeNull();
    expect(await inA((tx) => listContracts(tx))).toEqual([]);
    expect(await inA((tx) => listContractEvents(tx, id))).toEqual([]);
    expect(await inA((tx) => saveDraft(tx, id, { fields: FIELDS, signature_fields: [] }))).toBe(false);
    expect(await inA((tx) => copyContractAsDraft(tx, id))).toBeNull();
    expect(await inA((tx) => deleteDraftContract(tx, id))).toBe('not_found');
    expect(await inOrg(kit.orgB, (tx) => getContract(tx, id))).not.toBeNull();
  });
});

describe('saveDraft', () => {
  it('只有草稿能寫入，寫入後 updated_at 有值', async () => {
    const id = await seedContract();
    expect(await inA((tx) => saveDraft(tx, id, { fields: { ...FIELDS, rent: 30000 }, signature_fields: [] }))).toBe(true);
    const saved = await inA((tx) => getContract(tx, id));
    expect((saved as LeaseContract | null)?.fields.rent).toBe(30000);
    expect(saved?.updated_at).toMatch(/^\d{4}-/);

    await inA((tx) => commitTransition(tx, id, { status: 'awaiting_tenant', event: { type: 'sent', actor: 'landlord' } }));
    expect(await inA((tx) => saveDraft(tx, id, { fields: { ...FIELDS, rent: 1 }, signature_fields: [] }))).toBe(false);
    expect(((await inA((tx) => getContract(tx, id))) as LeaseContract | null)?.fields.rent).toBe(30000);
  });
});

describe('copyContractAsDraft：衍生關聯（ADR-0006）', () => {
  it('撤回後複製：新草稿的 derived_from 指向舊約，新約記衍生附註，來源記「被複製」', async () => {
    const source = await seedContract('voided');
    const newId = (await inA((tx) => copyContractAsDraft(tx, source)))!;

    const copy = await inA((tx) => getContract(tx, newId));
    expect(copy).toMatchObject({ derived_from: source, status: 'draft', fields: FIELDS });
    expect((await inA((tx) => listContractEvents(tx, newId))).map((e) => [e.type, e.note])).toEqual([
      ['created', `衍生自合約 #${source.slice(-6)}（撤回後修約）`],
    ]);
    const sourceEvents = await inA((tx) => listContractEvents(tx, source));
    expect(sourceEvents.at(-1)).toMatchObject({ type: 'copied', note: `複製為新草稿：合約 #${newId.slice(-6)}` });
  });

  it('拒簽後複製：不記衍生關聯', async () => {
    const source = await seedContract('declined');
    const newId = (await inA((tx) => copyContractAsDraft(tx, source)))!;
    expect((await inA((tx) => getContract(tx, newId)))?.derived_from).toBeNull();
    expect((await inA((tx) => listContractEvents(tx, newId)))[0].note).toBeNull();
  });

  it('複製記稽核事件，payload 說明來源與是否衍生', async () => {
    const source = await seedContract('voided');
    const newId = (await inA((tx) => copyContractAsDraft(tx, source)))!;
    const rows = await inA((tx) =>
      tx.query<{ object_id: string; payload: unknown }>(`SELECT object_id, payload FROM audit.events WHERE action = 'contract.copy'`),
    );
    expect(rows.rows).toEqual([{ object_id: newId, payload: { source_id: source, derived: true } }]);
  });

  it('來源事件寫入失敗時，新約與新約的歷程一起回滾', async () => {
    const source = await seedContract('voided');
    await kit.asOwner((db) =>
      db.exec(`CREATE FUNCTION org.fail_copied() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '歷程寫入失敗'; END $$;
               CREATE TRIGGER fail_copied BEFORE INSERT ON org.contract_events FOR EACH ROW WHEN (NEW.type = 'copied') EXECUTE FUNCTION org.fail_copied();`),
    );
    await expect(inA((tx) => copyContractAsDraft(tx, source))).rejects.toThrow('歷程寫入失敗');
    expect((await inA((tx) => listContracts(tx))).map((c) => c.id)).toEqual([source]);
    expect(await kit.asOwner(async (db) => (await db.query('SELECT type FROM org.contract_events WHERE contract_id <> $1', [source])).rows)).toEqual([]);
  });

  it('稽核寫入失敗時整筆回滾', async () => {
    const source = await seedContract('voided');
    vi.mocked(appendAudit).mockRejectedValueOnce(new Error('稽核寫入失敗'));
    await expect(inA((tx) => copyContractAsDraft(tx, source))).rejects.toThrow('稽核寫入失敗');
    expect((await inA((tx) => listContracts(tx))).map((c) => c.id)).toEqual([source]);
    expect((await inA((tx) => listContractEvents(tx, source))).map((e) => e.type)).toEqual(['created', 'voided']);
  });
});

describe('getContractRelations（前身與後繼）', () => {
  it('沒有任何關聯時前身為 null、後繼為空陣列', async () => {
    const id = await seedContract();
    const contract = (await inA((tx) => getContract(tx, id)))!;
    expect(await inA((tx) => getContractRelations(tx, contract))).toEqual({ derived_from: null, derived_contracts: [] });
  });

  it('撤回後複製：新約查得到前身，舊約查得到後繼（各帶狀態）', async () => {
    const source = await seedContract('voided');
    const newId = (await inA((tx) => copyContractAsDraft(tx, source)))!;
    const relations = (id: string) => inA(async (tx) => getContractRelations(tx, (await getContract(tx, id))!));

    expect(await relations(newId)).toEqual({ derived_from: { id: source, status: 'voided' }, derived_contracts: [] });
    expect(await relations(source)).toEqual({ derived_from: null, derived_contracts: [{ id: newId, status: 'draft' }] });
  });

  it('拒簽後複製：兩邊都查不到衍生關聯', async () => {
    const source = await seedContract('declined');
    const newId = (await inA((tx) => copyContractAsDraft(tx, source)))!;
    const relations = (id: string) => inA(async (tx) => getContractRelations(tx, (await getContract(tx, id))!));
    expect((await relations(newId)).derived_from).toBeNull();
    expect((await relations(source)).derived_contracts).toEqual([]);
  });

  it('同一份撤回合約衍生多份新約時，後繼依建立順序列出', async () => {
    const source = await seedContract('voided');
    const first = (await inA((tx) => copyContractAsDraft(tx, source)))!;
    const second = (await inA((tx) => copyContractAsDraft(tx, source)))!;
    const relations = await inA(async (tx) => getContractRelations(tx, (await getContract(tx, source))!));
    expect(relations.derived_contracts.map((c) => c.id)).toEqual([first, second]);
  });

  it('多層衍生鏈：中間那份同時有前身與後繼', async () => {
    const first = await seedContract('voided');
    const second = (await inA((tx) => copyContractAsDraft(tx, first)))!;
    await inA((tx) => commitTransition(tx, second, { status: 'voided', event: { type: 'voided', actor: 'landlord' } }));
    const third = (await inA((tx) => copyContractAsDraft(tx, second)))!;
    const relations = await inA(async (tx) => getContractRelations(tx, (await getContract(tx, second))!));
    expect(relations).toEqual({
      derived_from: { id: first, status: 'voided' },
      derived_contracts: [{ id: third, status: 'draft' }],
    });
  });
});

describe('deleteDraftContract', () => {
  it('刪草稿：歷程隨合約一起刪，只刪那一份，並記稽核事件', async () => {
    const keep = await seedContract();
    const drop = await seedContract();
    expect(await inA((tx) => deleteDraftContract(tx, drop))).toBe('deleted');

    expect(await inA((tx) => getContract(tx, drop))).toBeNull();
    expect((await inA((tx) => listContractEvents(tx, keep))).length).toBe(1);
    expect(await kit.asOwner(async (db) => (await db.query('SELECT 1 FROM org.contract_events WHERE contract_id = $1', [drop])).rows)).toEqual([]);
    expect((await auditActions()).filter((a) => a.action === 'contract.delete')).toEqual([{ action: 'contract.delete', object_id: drop }]);
  });

  it('非草稿不得刪，也不記稽核事件', async () => {
    const id = await seedContract('voided');
    expect(await inA((tx) => deleteDraftContract(tx, id))).toBe('not_draft');
    expect(await inA((tx) => getContract(tx, id))).not.toBeNull();
    expect((await auditActions()).filter((a) => a.action === 'contract.delete')).toEqual([]);
  });

  it('找不到回 not_found', async () => {
    expect(await inA((tx) => deleteDraftContract(tx, newUlid()))).toBe('not_found');
  });

  it('稽核寫入失敗時，合約與歷程都留著', async () => {
    const id = await seedContract();
    vi.mocked(appendAudit).mockRejectedValueOnce(new Error('稽核寫入失敗'));
    await expect(inA((tx) => deleteDraftContract(tx, id))).rejects.toThrow('稽核寫入失敗');
    expect(await inA((tx) => getContract(tx, id))).not.toBeNull();
    expect((await inA((tx) => listContractEvents(tx, id))).length).toBe(1);
  });

  it('被別的合約衍生的合約不能刪（外鍵）', async () => {
    // 草稿不會被衍生，這裡直接把一份草稿設成別人的前身，驗證資料庫的最後一道
    const first = await seedContract('voided');
    const second = (await inA((tx) => copyContractAsDraft(tx, first)))!;
    await inA((tx) => tx.query(`UPDATE org.contracts SET status = 'draft' WHERE id = $1`, [first]));
    await expect(inA((tx) => deleteDraftContract(tx, first))).rejects.toThrow(/foreign key|violates/i);
    expect(await inA((tx) => getContract(tx, second))).not.toBeNull();
  });
});

describe('commitTransition 與歷程', () => {
  it('狀態、拒簽原因與歷程同交易寫入；歷程依發生順序', async () => {
    const id = await seedContract();
    await inA(async (tx) => {
      await commitTransition(tx, id, { status: 'awaiting_tenant', event: { type: 'sent', actor: 'landlord', note: '寄送給乙方 t@example.com' } });
      await commitTransition(tx, id, { status: 'declined', declinedReason: '租金太高', event: { type: 'declined', actor: 'party_b', note: '租金太高' } });
    });
    const contract = await inA((tx) => getContract(tx, id));
    expect(contract).toMatchObject({ status: 'declined', declined_reason: '租金太高' });
    expect((await inA((tx) => listContractEvents(tx, id))).map((e) => e.type)).toEqual(['created', 'sent', 'declined']);
  });

  it('歷程寫入失敗時，狀態一起回滾', async () => {
    const id = await seedContract();
    await expect(
      inA((tx) => commitTransition(tx, id, { status: 'awaiting_tenant', event: { type: 'bogus' as never, actor: 'landlord' } })),
    ).rejects.toThrow(/check constraint/i);
    expect((await inA((tx) => getContract(tx, id)))?.status).toBe('draft');
  });

  it('合約不存在時丟錯', async () => {
    await expect(inA((tx) => commitTransition(tx, newUlid(), { status: 'completed', event: { type: 'completed', actor: 'system' } }))).rejects.toThrow(
      '合約不存在',
    );
  });

  it('appendContractEvent 掛不到別的組織的合約', async () => {
    const id = await seedContract('draft', kit.orgB);
    await expect(inA((tx) => appendContractEvent(tx, id, { type: 'created', actor: 'landlord' }))).rejects.toThrow(/foreign key|violates/i);
  });
});

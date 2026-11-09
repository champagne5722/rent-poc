import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgDriver } from '@/lib/pg/drivers';
import { createPgTestDatabase, type PgTestDatabase } from '@/lib/pg/pg-database-kit';
import { newUlid } from '@/lib/pg/ulid';
import { createWithTx, type OrgTx, type WithTx } from '@/lib/pg/with-tx';
import { createProperty, parsePropertyInput, removeProperty } from '@/lib/properties';
import { applySigningResult } from '@/lib/transitions';
import type { ContractFields } from '@/lib/types';
import {
  commitTransition,
  copyContractAsDraft,
  createContract,
  deleteDraftContract,
  getContract,
  getContractRelations,
  listContractEvents,
  listContracts,
  saveDraft,
} from '.';

// 真實 PostgreSQL（pg 驅動、連線池 4 條、app_rw）。PGlite 與 pg 的型別轉換不完全相同：
// timestamptz、jsonb、bigint。這裡確認 pg 路徑一樣，並驗證 PGlite 測不出的並發行為。
// 只在有 TEST_DATABASE_URL 時執行（見 pg-integration.test.ts）。

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('合約 repository（真實 PostgreSQL）', () => {
  let dbh: PgTestDatabase;
  let withTx: WithTx;
  const orgA = newUlid();
  const orgB = newUlid();

  beforeAll(async () => {
    dbh = await createPgTestDatabase(adminUrl!, 4);
    withTx = createWithTx(pgDriver(dbh.pool));
    await dbh.owner.query(
      `SET ROLE app_owner; INSERT INTO control.orgs (id, name, kind) VALUES ('${orgA}', 'A', 'owner'), ('${orgB}', 'B', 'owner'); RESET ROLE`,
    );
  });
  afterAll(() => dbh.close());

  const inOrg = <T>(orgId: string, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId }, fn);
  const inA = <T>(fn: (tx: OrgTx) => Promise<T>) => inOrg(orgA, fn);

  const FIELDS = {
    landlordName: '林房東',
    rent: 28000,
    routing: { businessType: 'self_managed', lesseeIsMasterLessor: false, brokerMediated: false },
    equipmentAnnex: [{ name: '冷氣', quantity: 1, repair: 'landlord', note: '' }],
  } as unknown as ContractFields;

  async function newProperty(orgId = orgA): Promise<string> {
    const parsed = parsePropertyInput({ name: '物件', address: '台北市大安區某路 1 號', equipment: [] });
    if (!parsed.ok) throw new Error(parsed.error);
    return inOrg(orgId, (tx) => createProperty(tx, parsed.value));
  }

  it('建立、讀取、儲存、複製、刪除：ULID、jsonb 物件、ISO 時間、數字都轉對', async () => {
    const propertyId = await newProperty();
    const sig = [{ id: 'f1', signer: 'party_a', page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.05 }];
    const id = await inA((tx) => createContract(tx, { property_id: propertyId, fields: FIELDS, signature_fields: sig as never }));

    const contract = await inA((tx) => getContract(tx, id));
    expect(contract).toEqual({
      id,
      property_id: propertyId,
      contract_type: 'lease',
      status: 'draft',
      fields: FIELDS,
      signature_fields: sig,
      declined_reason: null,
      derived_from: null,
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      updated_at: null,
    });

    expect(await inA((tx) => saveDraft(tx, id, { fields: { ...FIELDS, rent: 30000 }, signature_fields: [] }))).toBe(true);
    expect((await inA((tx) => getContract(tx, id)))?.fields.rent).toBe(30000);

    await inA((tx) => commitTransition(tx, id, { status: 'voided', event: { type: 'voided', actor: 'landlord' } }));
    const copyId = (await inA((tx) => copyContractAsDraft(tx, id)))!;
    expect(await inA(async (tx) => getContractRelations(tx, (await getContract(tx, copyId))!))).toEqual({
      derived_from: { id, status: 'voided' },
      derived_contracts: [],
    });
    expect(await inA((tx) => deleteDraftContract(tx, copyId))).toBe('deleted');
    expect((await inA((tx) => listContractEvents(tx, id))).map((e) => e.type)).toEqual(['created', 'voided', 'copied']);
  });

  it('A 組織的合約引用 B 組織的物件：複合外鍵擋下，整筆回滾', async () => {
    const bProperty = await newProperty(orgB);
    const before = (await inA((tx) => listContracts(tx))).length;
    await expect(inA((tx) => createContract(tx, { property_id: bProperty, fields: FIELDS }))).rejects.toThrow(/foreign key|violates/i);
    expect((await inA((tx) => listContracts(tx))).length).toBe(before);
  });

  it('app_rw 不能修改或刪除歷程；刪草稿時歷程經外鍵一起刪除', async () => {
    const id = await inA((tx) => createContract(tx, { property_id: null, fields: FIELDS }));
    await expect(inA((tx) => tx.query(`UPDATE org.contract_events SET note = 'x' WHERE contract_id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(inA((tx) => tx.query('DELETE FROM org.contract_events WHERE contract_id = $1', [id]))).rejects.toThrow(/permission denied/);
    expect(await inA((tx) => deleteDraftContract(tx, id))).toBe('deleted');
    const left = await dbh.owner.query('SELECT 1 FROM org.contract_events WHERE contract_id = $1', [id]);
    expect(left.rows).toEqual([]);
  });

  it('兩個交易同時複製同一份撤回合約：各得一份新約，後繼兩份都在', async () => {
    const source = await inA(async (tx) => {
      const id = await createContract(tx, { property_id: null, fields: FIELDS });
      await commitTransition(tx, id, { status: 'voided', event: { type: 'voided', actor: 'landlord' } });
      return id;
    });
    const [first, second] = await Promise.all([inA((tx) => copyContractAsDraft(tx, source)), inA((tx) => copyContractAsDraft(tx, source))]);
    expect(first).not.toBe(second);
    const relations = await inA(async (tx) => getContractRelations(tx, (await getContract(tx, source))!));
    expect(relations.derived_contracts.map((c) => c.id).sort()).toEqual([first!, second!].sort());
  });

  it('兩個交易同時套用同一個簽署結果：只轉移一次（鎖列後重讀狀態）', async () => {
    const id = await inA((tx) => createContract(tx, { property_id: null, fields: FIELDS }));
    await inA((tx) => commitTransition(tx, id, { status: 'awaiting_tenant', event: { type: 'sent', actor: 'landlord' } }));
    const results = await Promise.all([
      inA((tx) => applySigningResult(tx, id, { type: 'completed' })),
      inA((tx) => applySigningResult(tx, id, { type: 'completed' })),
    ]);
    expect(results.filter((r) => r === 'completed')).toHaveLength(1);
    expect((await inA((tx) => listContractEvents(tx, id))).map((e) => e.type)).toEqual(['created', 'sent', 'completed']);
  });

  it('刪除物件與建立合約同時發生：不會留下指向已刪物件的合約（刪除或封存二擇一，合約不孤兒）', async () => {
    for (let i = 0; i < 5; i++) {
      const propertyId = await newProperty();
      const outcomes = await Promise.allSettled([
        inA((tx) => removeProperty(tx, propertyId)),
        inA((tx) => createContract(tx, { property_id: propertyId, fields: FIELDS })),
      ]);
      const orphans = await dbh.owner.query(
        `SELECT c.id FROM org.contracts c WHERE c.property_id = $1 AND NOT EXISTS (SELECT 1 FROM org.properties p WHERE p.id = c.property_id)`,
        [propertyId],
      );
      expect(orphans.rows, JSON.stringify(outcomes.map((o) => o.status))).toEqual([]);
    }
  });
});

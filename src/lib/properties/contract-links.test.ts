import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContract } from '@/lib/contracts';
import { withTx } from '@/lib/pg/database';
import { setupRouteDb, type RouteDb } from '@/lib/pg/route-test-kit';
import type { ContractType } from '@/lib/labels';
import type { OrgTx } from '@/lib/pg/with-tx';
import type { ContractFields } from '@/lib/types';
import { hasActiveLeaseForProperty, hasContractsForProperty, taipeiToday } from './contract-links';
import { createProperty, parsePropertyInput, removeProperty } from '.';

// MIL-145 的物件與合約接縫，MIL-83 之後的 PostgreSQL 實作。連線是 PGlite 的 app_rw，RLS 生效。
// 併發的情境（刪除與建合約同時發生）PGlite 是單連線測不出，見 contracts.pg.test.ts。
// 這裡驗證併發情境靠的兩個機制：RLS 隔離組織、複合外鍵擋下指向已刪物件的合約。

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(() => kit.reset());

const inOrg = <T>(orgId: string, fn: (tx: OrgTx) => Promise<T>): Promise<T> => withTx({ kind: 'org', orgId }, fn);

async function newProperty(orgId: string): Promise<string> {
  const parsed = parsePropertyInput({ name: '物件', address: '台北市大安區某路 1 號', equipment: [] });
  if (!parsed.ok) throw new Error(parsed.error);
  return inOrg(orgId, (tx) => createProperty(tx, parsed.value));
}

/** 放一份合約。status 與租期止日由測試決定，狀態在同組織的交易內直接改。 */
async function add(
  orgId: string,
  propertyId: string,
  status: string,
  fields: Record<string, unknown>,
  type: ContractType = 'lease',
): Promise<string> {
  const id = await inOrg(orgId, (tx) =>
    createContract(tx, { property_id: propertyId, fields: fields as unknown as ContractFields, contract_type: type }),
  );
  await inOrg(orgId, (tx) => tx.query('UPDATE org.contracts SET status = $1 WHERE id = $2', [status, id]));
  return id;
}

describe('hasContractsForProperty', () => {
  it('沒有合約是 false，有任何狀態與類型的合約都是 true，別的物件的合約不算', async () => {
    const property = await newProperty(kit.orgA);
    const other = await newProperty(kit.orgA);
    const check = (id: string) => inOrg(kit.orgA, (tx) => hasContractsForProperty(id, tx));
    expect(await check(property)).toBe(false);
    await add(kit.orgA, other, 'completed', {});
    expect(await check(property)).toBe(false);
    await add(kit.orgA, property, 'voided', {}, 'management');
    expect(await check(property)).toBe(true);
  });

  it('在呼叫端的交易內查：同一個交易剛建的合約看得到，交易回滾就看不到', async () => {
    const property = await newProperty(kit.orgA);
    await expect(
      inOrg(kit.orgA, async (tx) => {
        await createContract(tx, { property_id: property, fields: {} as ContractFields });
        expect(await hasContractsForProperty(property, tx)).toBe(true);
        throw new Error('故意回滾');
      }),
    ).rejects.toThrow('故意回滾');
    expect(await inOrg(kit.orgA, (tx) => hasContractsForProperty(property, tx))).toBe(false);
  });

  it('別的組織的物件 ID 查不到合約（RLS）', async () => {
    const property = await newProperty(kit.orgA);
    await add(kit.orgA, property, 'draft', {});
    expect(await inOrg(kit.orgB, (tx) => hasContractsForProperty(property, tx))).toBe(false);
  });
});

describe('hasActiveLeaseForProperty', () => {
  const NOW = new Date('2026-11-09T02:00:00Z'); // 台北時間 2026-11-09 10:00
  const check = (id: string, orgId = kit.orgA) => inOrg(orgId, (tx) => hasActiveLeaseForProperty(id, tx, NOW));

  it('已完成的租賃合約，租期止日當天與之後算未屆滿，前一天算已屆滿', async () => {
    const property = await newProperty(kit.orgA);
    await add(kit.orgA, property, 'completed', { endDate: '2026-11-08' });
    expect(await check(property)).toBe(false);
    await add(kit.orgA, property, 'completed', { endDate: '2026-11-09' });
    expect(await check(property)).toBe(true);
  });

  it('租期止日沒填的已完成合約，保守視為未屆滿', async () => {
    const property = await newProperty(kit.orgA);
    await add(kit.orgA, property, 'completed', {});
    expect(await check(property)).toBe(true);
  });

  it('未完成的狀態與委託管理合約不算', async () => {
    const property = await newProperty(kit.orgA);
    for (const status of ['draft', 'awaiting_tenant', 'awaiting_practitioner', 'awaiting_landlord', 'declined', 'voided']) {
      await add(kit.orgA, property, status, { endDate: '2999-12-31' });
    }
    await add(kit.orgA, property, 'completed', { endDate: '2999-12-31' }, 'management');
    expect(await check(property)).toBe(false);
  });

  it('別的組織查不到', async () => {
    const property = await newProperty(kit.orgA);
    await add(kit.orgA, property, 'completed', { endDate: '2999-12-31' });
    expect(await check(property, kit.orgB)).toBe(false);
  });
});

describe('刪除與建合約交錯不留孤兒合約（MIL-145 交接的競態）', () => {
  it('刪除已完成，之後才建合約：複合外鍵擋下，沒有指向已刪物件的合約', async () => {
    const property = await newProperty(kit.orgA);
    expect(await inOrg(kit.orgA, (tx) => removeProperty(tx, property))).toBe('deleted');
    await expect(inOrg(kit.orgA, (tx) => createContract(tx, { property_id: property, fields: {} as ContractFields }))).rejects.toThrow();
    const { rows } = await inOrg(kit.orgA, (tx) => tx.query('SELECT 1 FROM org.contracts WHERE property_id = $1', [property]));
    expect(rows).toHaveLength(0);
  });

  it('合約先建好，之後刪除：改為封存，物件與合約都還在', async () => {
    const property = await newProperty(kit.orgA);
    const contractId = await add(kit.orgA, property, 'draft', {});
    expect(await inOrg(kit.orgA, (tx) => removeProperty(tx, property))).toBe('archived');
    const { rows } = await inOrg(kit.orgA, (tx) => tx.query('SELECT id FROM org.contracts WHERE property_id = $1', [property]));
    expect(rows).toEqual([{ id: contractId }]);
  });
});

describe('taipeiToday', () => {
  it('用台北時間算日期：UTC 16:00 之後已是台北的隔天', () => {
    expect(taipeiToday(new Date('2026-11-08T15:59:00Z'))).toBe('2026-11-08');
    expect(taipeiToday(new Date('2026-11-08T16:00:00Z'))).toBe('2026-11-09');
  });
});

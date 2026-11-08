import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { copyContractAsDraft, createContract, getContract } from '../contracts';
import { withTx } from '../pg/database';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import type { ContractFields } from '../types';
import { loadContractRoutingFacts } from './repository';

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(() => kit.reset());

const inA = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: kit.orgA }, fn);

function seed(fields: unknown, contractType?: 'lease' | 'management'): Promise<string> {
  return inA((tx) =>
    createContract(tx, { property_id: null, fields: fields as ContractFields, contract_type: contractType }),
  );
}

describe('contracts.contract_type 欄位', () => {
  it('新建的合約預設是 lease', async () => {
    const id = await seed({});
    expect((await inA((tx) => getContract(tx, id)))?.contract_type).toBe('lease');
  });

  it('可以建立 management 合約', async () => {
    const id = await seed({}, 'management');
    expect((await inA((tx) => getContract(tx, id)))?.contract_type).toBe('management');
  });

  it('只接受 lease 與 management', async () => {
    await expect(seed({}, 'receipt' as 'lease')).rejects.toThrow(/check constraint/i);
  });

  it('複製為新草稿時沿用合約類型與分流條件', async () => {
    const routing = { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: true };
    const sourceId = await seed({ routing }, 'management');
    const newId = (await inA((tx) => copyContractAsDraft(tx, sourceId)))!;

    const copy = (await inA((tx) => getContract(tx, newId)))!;
    expect(copy.contract_type).toBe('management');
    expect(copy.fields.routing).toEqual(routing);
  });
});

describe('loadContractRoutingFacts', () => {
  it('合約不存在', async () => {
    expect(await inA((tx) => loadContractRoutingFacts(tx, newUlid()))).toEqual({ ok: false, code: 'not_found', reason: '合約不存在' });
  });

  it('既有合約沒有分流條件時，視為自管租賃合約', async () => {
    const id = await seed({ landlordName: '林房東' });
    expect(await inA((tx) => loadContractRoutingFacts(tx, id))).toEqual({
      ok: true,
      contractType: 'lease',
      facts: { documentType: 'lease', businessType: 'self_managed', lesseeIsMasterLessor: false, brokerMediated: false },
    });
  });

  it('讀取合約上快照的分流條件', async () => {
    const id = await seed({ routing: { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: true } });
    const result = await inA((tx) => loadContractRoutingFacts(tx, id));
    expect(result).toMatchObject({
      ok: true,
      facts: { documentType: 'lease', businessType: 'master_lease', brokerMediated: true },
    });
  });

  it('委託管理合約的文件類型是 management，沒有分流條件時業務類型是代管', async () => {
    const id = await seed({}, 'management');
    expect(await inA((tx) => loadContractRoutingFacts(tx, id))).toEqual({
      ok: true,
      contractType: 'management',
      facts: { documentType: 'management', businessType: 'managed' },
    });
  });

  it('分流條件的形狀不對時回報錯誤，不退回預設值', async () => {
    const id = await seed({ routing: { businessType: 'sublease', lesseeIsMasterLessor: false, brokerMediated: false } });
    const result = await inA((tx) => loadContractRoutingFacts(tx, id));
    expect(result).toMatchObject({ ok: false, code: 'invalid_routing' });

    const partial = await seed({ routing: { businessType: 'managed' } });
    expect(await inA((tx) => loadContractRoutingFacts(tx, partial))).toMatchObject({ ok: false, code: 'invalid_routing' });
  });
});

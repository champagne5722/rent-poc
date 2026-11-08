import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyContractAsDraft, ensureSchema, getContract, insertContractWithEvent, setDb } from '../db';
import { loadContractRoutingFacts } from './repository';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  ensureSchema(db);
  setDb(db);
});

afterEach(() => {
  setDb(null);
  db.close();
});

function seed(fields: unknown, contractType?: string): number {
  const result = contractType
    ? db
        .prepare("INSERT INTO contracts (status, fields, contract_type) VALUES ('draft', ?, ?)")
        .run(JSON.stringify(fields), contractType)
    : db.prepare("INSERT INTO contracts (status, fields) VALUES ('draft', ?)").run(JSON.stringify(fields));
  return Number(result.lastInsertRowid);
}

describe('contracts.contract_type 欄位', () => {
  it('新建的合約預設是 lease', () => {
    const id = insertContractWithEvent({ property_id: null, fields: '{}' }, { type: 'created', actor: 'landlord' }, db);
    expect(getContract(id)?.contract_type).toBe('lease');
  });

  it('可以建立 management 合約', () => {
    const id = insertContractWithEvent(
      { property_id: null, fields: '{}', contract_type: 'management' },
      { type: 'created', actor: 'landlord' },
      db,
    );
    expect(getContract(id)?.contract_type).toBe('management');
  });

  it('只接受 lease 與 management', () => {
    expect(() => seed({}, 'receipt')).toThrow();
  });

  it('既有資料表補欄位後，既有合約全部是 lease，重跑不出錯', () => {
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE contracts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        property_id INTEGER,
        status TEXT NOT NULL DEFAULT 'draft',
        fields TEXT NOT NULL DEFAULT '{}',
        signature_fields TEXT NOT NULL DEFAULT '[]',
        declined_reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT
      );
    `);
    legacy.prepare("INSERT INTO contracts (status) VALUES ('completed')").run();
    legacy.prepare("INSERT INTO contracts (status) VALUES ('draft')").run();

    ensureSchema(legacy);

    expect(legacy.prepare('SELECT contract_type FROM contracts ORDER BY id').all()).toEqual([
      { contract_type: 'lease' },
      { contract_type: 'lease' },
    ]);
    expect(() => ensureSchema(legacy)).not.toThrow();
    legacy.close();
  });

  it('複製為新草稿時沿用合約類型與分流條件', () => {
    const routing = { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: true };
    const sourceId = seed({ routing }, 'management');
    const newId = copyContractAsDraft(getContract(sourceId)!, db);

    const copy = getContract(newId)!;
    expect(copy.contract_type).toBe('management');
    expect(copy.fields.routing).toEqual(routing);
  });
});

describe('loadContractRoutingFacts', () => {
  it('合約不存在', async () => {
    expect(await loadContractRoutingFacts(999)).toEqual({ ok: false, code: 'not_found', reason: '合約不存在' });
  });

  it('既有合約沒有分流條件時，視為自管租賃合約', async () => {
    const id = seed({ landlordName: '林房東' });
    expect(await loadContractRoutingFacts(id)).toEqual({
      ok: true,
      contractType: 'lease',
      facts: { documentType: 'lease', businessType: 'self_managed', lesseeIsMasterLessor: false, brokerMediated: false },
    });
  });

  it('讀取合約上快照的分流條件', async () => {
    const id = seed({ routing: { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: true } });
    const result = await loadContractRoutingFacts(id);
    expect(result).toMatchObject({
      ok: true,
      facts: { documentType: 'lease', businessType: 'master_lease', brokerMediated: true },
    });
  });

  it('委託管理合約的文件類型是 management，沒有分流條件時業務類型是代管', async () => {
    const id = seed({}, 'management');
    expect(await loadContractRoutingFacts(id)).toEqual({
      ok: true,
      contractType: 'management',
      facts: { documentType: 'management', businessType: 'managed' },
    });
  });

  it('分流條件的形狀不對時回報錯誤，不退回預設值', async () => {
    const id = seed({ routing: { businessType: 'sublease', lesseeIsMasterLessor: false, brokerMediated: false } });
    const result = await loadContractRoutingFacts(id);
    expect(result).toMatchObject({ ok: false, code: 'invalid_routing' });

    const partial = seed({ routing: { businessType: 'managed' } });
    expect(await loadContractRoutingFacts(partial)).toMatchObject({ ok: false, code: 'invalid_routing' });
  });

  it('欄位 JSON 損壞時回報錯誤', async () => {
    db.prepare("INSERT INTO contracts (status, fields) VALUES ('draft', '{bad')").run();
    const id = Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
    expect(await loadContractRoutingFacts(id)).toMatchObject({ ok: false, code: 'invalid_routing' });
  });
});

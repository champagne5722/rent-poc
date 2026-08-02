import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyContractAsDraft, ensureSchema, getContract, getContractRelations, setDb } from './db';
import type { Contract, ContractStatus } from './types';

// 衍生關聯測試（ADR-0006）：一律走 in-memory DB，不碰 data/ 下的檔案
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

function seedContract(status: ContractStatus): Contract {
  const result = db
    .prepare("INSERT INTO contracts (property_id, status, fields, signature_fields) VALUES (NULL, ?, '{}', '[]')")
    .run(status);
  return getContract(Number(result.lastInsertRowid)) as Contract;
}

function derivedFromOf(id: number): number | null {
  return (db.prepare('SELECT derived_from FROM contracts WHERE id = ?').get(id) as { derived_from: number | null })
    .derived_from;
}

describe('contracts.derived_from 欄位', () => {
  it('新建的合約預設沒有衍生來源', () => {
    const contract = seedContract('draft');
    expect(contract.derived_from).toBeNull();
  });

  it('ensureSchema 對缺少 derived_from 的既有資料表補欄位（無 migration 工具的相容做法）', () => {
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE contracts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        property_id INTEGER,
        status TEXT NOT NULL DEFAULT 'draft',
        fields TEXT NOT NULL DEFAULT '{}',
        signature_fields TEXT NOT NULL DEFAULT '[]',
        dottedsign_task_id TEXT,
        declined_reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT
      );
    `);
    legacy.prepare("INSERT INTO contracts (status) VALUES ('completed')").run();

    ensureSchema(legacy);

    const columns = (legacy.prepare('PRAGMA table_info(contracts)').all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain('derived_from');
    // 既有資料保留，補上的欄位為 NULL
    const row = legacy.prepare('SELECT status, derived_from FROM contracts WHERE id = 1').get();
    expect(row).toEqual({ status: 'completed', derived_from: null });

    // 重複執行不會出錯（每次開檔都會跑 ensureSchema）
    expect(() => ensureSchema(legacy)).not.toThrow();
    legacy.close();
  });
});

describe('copyContractAsDraft 記錄衍生關聯', () => {
  it('撤回後複製：新草稿的 derived_from 指向舊約', () => {
    const source = seedContract('voided');
    const newId = copyContractAsDraft(source, db);

    expect(derivedFromOf(newId)).toBe(source.id);
    expect(getContract(newId)?.derived_from).toBe(source.id);
  });

  it('拒簽後複製：不記衍生關聯（ADR-0006：拒簽是交易終點）', () => {
    const source = seedContract('declined');
    const newId = copyContractAsDraft(source, db);

    expect(derivedFromOf(newId)).toBeNull();
    expect(getContract(newId)?.derived_from).toBeNull();
  });
});

describe('getContractRelations（前身與後繼）', () => {
  it('沒有任何關聯時前身為 null、後繼為空陣列', () => {
    const contract = seedContract('draft');
    expect(getContractRelations(contract, db)).toEqual({ derived_from: null, derived_contracts: [] });
  });

  it('撤回後複製：新約查得到前身，舊約查得到後繼（各帶狀態）', () => {
    const source = seedContract('voided');
    const newId = copyContractAsDraft(source, db);

    const newContract = getContract(newId) as Contract;
    expect(getContractRelations(newContract, db)).toEqual({
      derived_from: { id: source.id, status: 'voided' },
      derived_contracts: [],
    });

    expect(getContractRelations(getContract(source.id) as Contract, db)).toEqual({
      derived_from: null,
      derived_contracts: [{ id: newId, status: 'draft' }],
    });
  });

  it('拒簽後複製：兩邊都查不到衍生關聯', () => {
    const source = seedContract('declined');
    const newId = copyContractAsDraft(source, db);

    expect(getContractRelations(getContract(newId) as Contract, db).derived_from).toBeNull();
    expect(getContractRelations(getContract(source.id) as Contract, db).derived_contracts).toEqual([]);
  });

  it('同一份撤回合約衍生多份新約時，後繼依 id 由小到大列出', () => {
    const source = seedContract('voided');
    const firstId = copyContractAsDraft(source, db);
    const secondId = copyContractAsDraft(source, db);

    expect(getContractRelations(getContract(source.id) as Contract, db).derived_contracts).toEqual([
      { id: firstId, status: 'draft' },
      { id: secondId, status: 'draft' },
    ]);
  });

  it('多層衍生鏈：中間那份同時有前身與後繼', () => {
    const first = seedContract('voided');
    const secondId = copyContractAsDraft(first, db);
    db.prepare("UPDATE contracts SET status='voided' WHERE id=?").run(secondId);
    const thirdId = copyContractAsDraft(getContract(secondId) as Contract, db);

    expect(getContractRelations(getContract(secondId) as Contract, db)).toEqual({
      derived_from: { id: first.id, status: 'voided' },
      derived_contracts: [{ id: thirdId, status: 'draft' }],
    });
  });
});

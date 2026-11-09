import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyContractAsDraft, deleteContractWithEvents, ensureSchema, getContract, insertContractWithEvent, setDb } from '../db';
import { defaultStatusAnnex, statusAnnexOf, type StatusAnnex } from './index';

// 現況確認附件隨草稿保存（MIL-71）：內容收在合約欄位，所以複製為新草稿會跟著複製，刪除草稿時一起消失，
// 沒有附件的舊包租合約讀入不報錯。

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

const MASTER = { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: false };

function annexWithDefect(): StatusAnnex {
  const annex = defaultStatusAnnex();
  return {
    ...annex,
    rows: annex.rows.map((r, i) => ({ ...r, status: i === 1 ? ('defect' as const) : ('normal' as const), note: i === 1 ? '浴室天花板有水漬' : '' })),
  };
}

function insert(fields: object): number {
  return insertContractWithEvent(
    { property_id: null, fields: JSON.stringify(fields), signature_fields: '[]' },
    { type: 'created', actor: 'landlord' },
    db,
  );
}

describe('現況確認附件的草稿生命週期', () => {
  it('存進草稿再讀回來，內容與版本、標籤都在', () => {
    const annex = annexWithDefect();
    const id = insert({ routing: MASTER, statusAnnex: annex });
    expect(getContract(id)?.fields).toMatchObject({ statusAnnex: annex });
  });

  it('複製為新草稿時附件內容跟著複製，兩份互不影響', () => {
    const annex = annexWithDefect();
    const id = insert({ routing: MASTER, statusAnnex: annex });
    const copyId = copyContractAsDraft(getContract(id)!, db);
    const copied = getContract(copyId)!;
    expect(copied.status).toBe('draft');
    expect('statusAnnex' in copied.fields && copied.fields.statusAnnex).toEqual(annex);
    expect(statusAnnexOf('draft', 'lease', copied.fields)).toEqual(annex);
    // 改新草稿不動來源
    db.prepare('UPDATE contracts SET fields = ? WHERE id = ?').run(JSON.stringify({ routing: MASTER, statusAnnex: defaultStatusAnnex() }), copyId);
    expect(getContract(id)?.fields).toMatchObject({ statusAnnex: annex });
  });

  it('刪除草稿時附件一併消失（內容在合約欄位，沒有殘留的子表資料）', () => {
    const id = insert({ routing: MASTER, statusAnnex: annexWithDefect() });
    deleteContractWithEvents(id, db);
    expect(getContract(id)).toBeNull();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%status_annex%'").all();
    expect(tables).toEqual([]);
  });

  it('沒有附件內容的舊包租合約讀入不報錯：草稿印預設清單，送簽後的舊合約不印附件頁', () => {
    const id = insert({ routing: MASTER, landlordName: '王', tenantName: '李' });
    const fields = getContract(id)!.fields;
    expect(() => statusAnnexOf('draft', 'lease', fields)).not.toThrow();
    expect(statusAnnexOf('draft', 'lease', fields)?.rows.every((r) => r.status === null)).toBe(true);
    expect(statusAnnexOf('completed', 'lease', fields)).toBeNull();
  });
});

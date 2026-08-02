import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema, getContractFile, listContractFiles, setDb, upsertContractFile } from './db';

// 資料庫測試一律走 in-memory DB，不碰 data/ 下的檔案
let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  ensureSchema(db);
  setDb(db);
  db.prepare("INSERT INTO contracts (id, status) VALUES (1, 'completed')").run();
});

afterEach(() => {
  setDb(null);
  db.close();
});

describe('contract_files 保存紀錄', () => {
  const saved = {
    contract_id: 1,
    kind: 'signed_pdf' as const,
    status: 'saved' as const,
    file_name: 'contract-1-signed.pdf',
    rel_path: 'contract-files/1/contract-1-signed.pdf',
    byte_size: 1024,
    content_type: 'application/pdf',
    error: null,
  };

  it('寫入後可依 kind 取回', () => {
    upsertContractFile(saved);
    const row = getContractFile(1, 'signed_pdf');
    expect(row).toMatchObject({ contract_id: 1, kind: 'signed_pdf', status: 'saved', byte_size: 1024 });
    expect(row?.saved_at).toBeTruthy();
    expect(getContractFile(1, 'audit_trail')).toBeNull();
  });

  it('同一合約同一種檔案只留一筆，重抓成功會覆蓋失敗紀錄', () => {
    upsertContractFile({
      contract_id: 1,
      kind: 'audit_trail',
      status: 'failed',
      file_name: 'contract-1-audit-trail.pdf',
      rel_path: null,
      byte_size: null,
      content_type: null,
      error: '點點簽未回傳下載連結',
    });
    expect(getContractFile(1, 'audit_trail')).toMatchObject({ status: 'failed', error: '點點簽未回傳下載連結' });

    upsertContractFile({
      contract_id: 1,
      kind: 'audit_trail',
      status: 'saved',
      file_name: 'contract-1-audit-trail.pdf',
      rel_path: 'contract-files/1/contract-1-audit-trail.pdf',
      byte_size: 2048,
      content_type: 'application/pdf',
      error: null,
    });

    const rows = listContractFiles(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'audit_trail', status: 'saved', byte_size: 2048, error: null });
  });

  it('列出時兩種檔案都在', () => {
    upsertContractFile(saved);
    upsertContractFile({ ...saved, kind: 'audit_trail', file_name: 'contract-1-audit-trail.pdf' });
    expect(listContractFiles(1).map((r) => r.kind).sort()).toEqual(['audit_trail', 'signed_pdf']);
  });
});

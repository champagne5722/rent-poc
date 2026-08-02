import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureSchema, listContractFiles, setDb } from './db';
import { contractFileAbsPath, contractFileRelPath, saveContractFiles, serveContractFile } from './contract-files';
import type { Contract } from './types';

// 點點簽整合層整個換掉：測試不打任何外部 API，只驗保存與下載的編排
vi.mock('./dottedsign', () => ({
  isMockMode: () => false,
  dsGetJson: async () => ({ data: { task: 'https://s3/task.pdf', audit_trail: 'https://s3/audit.pdf' } }),
}));

const CONTRACT_ID = 999999; // 測試專用編號，避免動到真的合約目錄
const contract = { id: CONTRACT_ID, status: 'completed', dottedsign_task_id: '470' } as Contract;

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  ensureSchema(db);
  setDb(db);
  db.prepare(`INSERT INTO contracts (id, status) VALUES (${CONTRACT_ID}, 'completed')`).run();
  vi.stubGlobal('fetch', async (url: string) => ({
    ok: true,
    headers: { get: () => 'application/pdf' },
    arrayBuffer: async () => new TextEncoder().encode(`fake-${url}`).buffer,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  setDb(null);
  db.close();
  fs.rmSync(contractFileAbsPath(`contract-files/${CONTRACT_ID}`), { recursive: true, force: true });
});

describe('完成時保存兩份文件', () => {
  it('已簽 PDF 與 Audit Trail File 都落地並入庫', async () => {
    expect(await saveContractFiles(contract)).toEqual([
      { kind: 'signed_pdf', ok: true },
      { kind: 'audit_trail', ok: true },
    ]);
    expect(fs.existsSync(contractFileAbsPath(contractFileRelPath(CONTRACT_ID, 'signed_pdf')))).toBe(true);
    expect(fs.existsSync(contractFileAbsPath(contractFileRelPath(CONTRACT_ID, 'audit_trail')))).toBe(true);
    expect(listContractFiles(CONTRACT_ID).map((r) => r.status)).toEqual(['saved', 'saved']);
  });

  it('已保存過就不重抓（補抓端點才會帶 force）', async () => {
    await saveContractFiles(contract);
    expect(await saveContractFiles(contract)).toEqual([]);
    expect(await saveContractFiles(contract, { force: true })).toHaveLength(2);
  });

  it('抓檔失敗記進 contract_files 供補抓，不拋例外', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 403, headers: { get: () => null } }));
    const results = await saveContractFiles(contract);
    expect(results.every((r) => !r.ok)).toBe(true);
    const rows = listContractFiles(CONTRACT_ID);
    expect(rows.map((r) => r.status)).toEqual(['failed', 'failed']);
    expect(rows[0].error).toContain('403');

    // 補抓成功後覆蓋失敗紀錄
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      headers: { get: () => 'application/pdf' },
      arrayBuffer: async () => new TextEncoder().encode('ok').buffer,
    }));
    await saveContractFiles(contract, { force: true });
    expect(listContractFiles(CONTRACT_ID).map((r) => r.status)).toEqual(['saved', 'saved']);
  });
});

describe('下載端點共用邏輯', () => {
  it('已完成回檔案本體與下載檔名', async () => {
    await saveContractFiles(contract);
    const res = await serveContractFile(contract, 'audit_trail');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('contract-999999-audit-trail.pdf');
    expect(await res.text()).toBe('fake-https://s3/audit.pdf');
  });

  it('未完成狀態回 409 與明確訊息', async () => {
    const res = await serveContractFile({ ...contract, status: 'awaiting_tenant' } as Contract, 'signed_pdf');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('尚未完成簽署');
  });

  it('沒保存到就當場補抓一次', async () => {
    const res = await serveContractFile(contract, 'signed_pdf');
    expect(res.status).toBe(200);
    expect(listContractFiles(CONTRACT_ID).map((r) => r.kind)).toEqual(['signed_pdf']);
  });
});

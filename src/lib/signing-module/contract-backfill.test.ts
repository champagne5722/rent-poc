import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractStatus } from '../types';
import { migrateLegacyContractSigning } from './contract-backfill';
import { createLegacyContractTables } from './legacy-schema.fixture';
import type { SigningSubject } from './provider';
import {
  ensureLegacySignTaskTables,
  findLegacySignTask as findSignTask,
  findLegacySubjectByTaskRef as findSubjectByTaskRef,
  legacyProgressOf as toSigningProgress,
  listLegacySignTaskFiles as listSignTaskFiles,
} from './legacy-sign-task-sqlite';

// 舊 SQLite 資料的回填（MIL-56、MIL-58）與舊形式移除（MIL-60）。
// 合約搬到 PostgreSQL 後（MIL-83），ensureSchema() 不再呼叫它，合約表也不在 SQLite 裡。
// 這個檔案留著，讓搬資料腳本（MIL-90）與簽署任務搬遷（MIL-85）有可重用、有測試的「合約狀態與歷程 → 簽署進度」對照。
// 這裡只驗 SQLite 內的結果：簽署任務、簽署人、文件紀錄。

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  ensureLegacySignTaskTables(db);
  createLegacyContractTables(db);
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

const FIELDS = JSON.stringify({
  landlordName: '林房東',
  landlordEmail: 'landlord@example.com',
  tenantName: '王租客',
  tenantEmail: 'tenant@example.com',
});

const TENANT = { role: 'party_b', name: '王租客', email: 'tenant@example.com' };
const LANDLORD = { role: 'party_a', name: '林房東', email: 'landlord@example.com' };

function legacyContract(status: ContractStatus, taskRef: string | null, fields = FIELDS): SigningSubject {
  const result = db
    .prepare(
      `INSERT INTO contracts (status, fields, dottedsign_task_id, created_at, updated_at)
       VALUES (?, ?, ?, '2026-01-01 09:00:00', '2026-01-05 09:00:00')`
    )
    .run(status, fields, taskRef);
  return { type: 'contract', id: String(result.lastInsertRowid) };
}

function legacyEvent(subject: SigningSubject, type: string, actor: string, createdAt: string) {
  db.prepare('INSERT INTO contract_events (contract_id, type, actor, created_at) VALUES (?, ?, ?, ?)').run(
    Number(subject.id),
    type,
    actor,
    createdAt
  );
}

const upgrade = () => migrateLegacyContractSigning(db);

const progressOf = (subject: SigningSubject) => {
  const task = findSignTask(db, subject);
  return task ? toSigningProgress(task) : null;
};

const columnsOf = (table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const tableExists = (table: string) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));

describe('回填後移除舊形式', () => {
  it('回填後移除合約的任務編號欄位與舊的合約文件表', () => {
    const subject = legacyContract('completed', '470');
    legacyFile(subject, 'signed_pdf', { status: 'saved' });
    upgrade();

    expect(columnsOf('contracts')).not.toContain('dottedsign_task_id');
    expect(tableExists('contract_files')).toBe(false);
    expect(progressOf(subject)).toMatchObject({ status: 'completed' });
    expect(listSignTaskFiles(db, findSignTask(db, subject)!.id)).toHaveLength(1);
  });

  it('有合約無法回填時保留舊形式，任務編號不會遺失', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    legacyContract('awaiting_tenant', 'mock-1-a', '{not json');
    const good = legacyContract('completed', '470');
    legacyFile(good, 'signed_pdf', { status: 'saved' });

    upgrade();

    expect(columnsOf('contracts')).toContain('dottedsign_task_id');
    expect(tableExists('contract_files')).toBe(true);
  });

  it('沒有舊形式的資料庫，重複執行是 no-op', () => {
    const fresh = new Database(':memory:');
    ensureLegacySignTaskTables(fresh);

    expect(() => migrateLegacyContractSigning(fresh)).not.toThrow();
    expect(() => migrateLegacyContractSigning(fresh)).not.toThrow();
    fresh.close();
  });
});

describe('回填的簽署進度', () => {
  it('待乙方簽：兩位都待簽，當前簽署人是乙方', () => {
    const subject = legacyContract('awaiting_tenant', 'mock-1-a');
    upgrade();

    expect(progressOf(subject)).toEqual({
      status: 'in_progress',
      signers: [
        { ...TENANT, status: 'pending', signedAt: null },
        { ...LANDLORD, status: 'pending', signedAt: null },
      ],
      currentSigner: TENANT,
    });
  });

  it('待甲方簽：乙方已簽，簽署時間取自合約歷程，當前簽署人是甲方', () => {
    const subject = legacyContract('awaiting_landlord', 'mock-1-a');
    legacyEvent(subject, 'tenant_signed', 'tenant', '2026-01-02 10:00:00');
    upgrade();

    expect(progressOf(subject)).toEqual({
      status: 'in_progress',
      signers: [
        { ...TENANT, status: 'signed', signedAt: '2026-01-02 10:00:00' },
        { ...LANDLORD, status: 'pending', signedAt: null },
      ],
      currentSigner: LANDLORD,
    });
  });

  it('已完成：兩位都已簽，甲方的簽署時間是完成時間', () => {
    const subject = legacyContract('completed', 'mock-1-a');
    legacyEvent(subject, 'tenant_signed', 'tenant', '2026-01-02 10:00:00');
    legacyEvent(subject, 'completed', 'landlord', '2026-01-03 10:00:00');
    upgrade();

    expect(progressOf(subject)).toEqual({
      status: 'completed',
      signers: [
        { ...TENANT, status: 'signed', signedAt: '2026-01-02 10:00:00' },
        { ...LANDLORD, status: 'signed', signedAt: '2026-01-03 10:00:00' },
      ],
      currentSigner: null,
    });
  });

  it('已完成但歷程沒有乙方簽署：乙方的簽署時間用完成時間', () => {
    const subject = legacyContract('completed', 'mock-1-a');
    legacyEvent(subject, 'completed', 'landlord', '2026-01-03 10:00:00');
    upgrade();

    expect(progressOf(subject)?.signers.map((s) => s.signedAt)).toEqual(['2026-01-03 10:00:00', '2026-01-03 10:00:00']);
  });

  it('已完成但沒有任何歷程：簽署時間用合約的更新時間', () => {
    const subject = legacyContract('completed', 'mock-1-a');
    upgrade();

    expect(progressOf(subject)?.signers.map((s) => s.signedAt)).toEqual(['2026-01-05 09:00:00', '2026-01-05 09:00:00']);
  });

  it('乙方拒簽：乙方標為拒簽，甲方維持待簽', () => {
    const subject = legacyContract('declined', 'mock-1-a');
    legacyEvent(subject, 'declined', 'tenant', '2026-01-02 10:00:00');
    upgrade();

    const progress = progressOf(subject);
    expect(progress?.status).toBe('declined');
    expect(progress?.signers.map((s) => s.status)).toEqual(['declined', 'pending']);
    expect(progress?.currentSigner).toBeNull();
  });

  it('甲方拒簽：乙方已簽，甲方標為拒簽', () => {
    const subject = legacyContract('declined', 'mock-1-a');
    legacyEvent(subject, 'tenant_signed', 'tenant', '2026-01-02 10:00:00');
    legacyEvent(subject, 'declined', 'landlord', '2026-01-03 10:00:00');
    upgrade();

    const progress = progressOf(subject);
    expect(progress?.status).toBe('declined');
    expect(progress?.signers.map((s) => [s.status, s.signedAt])).toEqual([
      ['signed', '2026-01-02 10:00:00'],
      ['declined', null],
    ]);
  });

  it.each([
    ['乙方簽署前撤回', [], ['pending', 'pending']],
    ['乙方簽署後撤回', [['tenant_signed', 'tenant']], ['signed', 'pending']],
  ])('%s：任務已撤回', (_label, events, expected) => {
    const subject = legacyContract('voided', 'mock-1-a');
    for (const [type, actor] of events) legacyEvent(subject, type, actor, '2026-01-02 10:00:00');
    upgrade();

    const progress = progressOf(subject);
    expect(progress?.status).toBe('voided');
    expect(progress?.signers.map((s) => s.status)).toEqual(expected);
    expect(progress?.currentSigner).toBeNull();
  });

  it('草稿與沒有任務編號的簽署中合約都不回填', () => {
    const draft = legacyContract('draft', null);
    const signingWithoutRef = legacyContract('awaiting_tenant', null);
    upgrade();

    expect(progressOf(draft)).toBeNull();
    expect(progressOf(signingWithoutRef)).toBeNull();
  });
});

describe('回填的服務商', () => {
  it('任務編號以 mock- 開頭時記為 Mock，其他記為點點簽；webhook 比對要帶服務商', () => {
    const mock = legacyContract('awaiting_tenant', 'mock-1-a');
    const live = legacyContract('awaiting_tenant', '470');
    upgrade();

    expect(findSubjectByTaskRef(db, 'mock', 'mock-1-a')).toEqual(mock);
    expect(findSubjectByTaskRef(db, 'dottedsign', 'mock-1-a')).toBeNull();
    expect(findSubjectByTaskRef(db, 'dottedsign', '470')).toEqual(live);
    expect(findSubjectByTaskRef(db, 'mock', '470')).toBeNull();
  });
});

describe('回填能重複執行', () => {
  it('第二次執行不改任何簽署進度，也不多建簽署任務', () => {
    const subjects = [
      legacyContract('awaiting_tenant', 'mock-1-a'),
      legacyContract('awaiting_landlord', 'mock-2-b'),
      legacyContract('completed', 'mock-3-c'),
      legacyContract('declined', 'mock-4-d'),
      legacyContract('voided', 'mock-5-e'),
    ];
    upgrade();
    const first = subjects.map(progressOf);
    expect(first.every(Boolean)).toBe(true);

    // 第一次回填成功後舊形式已移除，這裡把它補回去，模擬「舊形式還在」時重跑
    db.exec('ALTER TABLE contracts ADD COLUMN dottedsign_task_id TEXT');
    upgrade();

    expect(subjects.map(progressOf)).toEqual(first);
    expect(db.prepare('SELECT count(*) AS n FROM sign_tasks').get()).toEqual({ n: 5 });
  });
});

// 升級前的合約文件紀錄：檔案在 data/contract-files/<合約 id>/，以合約為鍵
function legacyFile(
  subject: SigningSubject,
  kind: 'signed_pdf' | 'audit_trail',
  row: { status: 'saved' | 'failed'; error?: string }
) {
  const suffix = kind === 'signed_pdf' ? 'signed' : 'audit-trail';
  const fileName = `contract-${subject.id}-${suffix}.pdf`;
  const relPath = row.status === 'saved' ? `contract-files/${subject.id}/${fileName}` : null;
  db.prepare(
    `INSERT INTO contract_files (contract_id, kind, status, file_name, rel_path, byte_size, content_type, error, saved_at)
     VALUES (?, ?, ?, ?, ?, ?, 'application/pdf', ?, '2026-01-05 09:00:00')`
  ).run(Number(subject.id), kind, row.status, fileName, relPath, relPath ? 10 : null, row.error ?? null);
}

describe('回填的合約文件', () => {
  it('既有文件紀錄轉入，舊檔案路徑原樣保留，不搬檔', () => {
    const subject = legacyContract('completed', '470');
    legacyFile(subject, 'signed_pdf', { status: 'saved' });
    legacyFile(subject, 'audit_trail', { status: 'saved' });
    upgrade();

    const files = listSignTaskFiles(db, findSignTask(db, subject)!.id);
    expect(files.map((f) => [f.kind, f.status, f.rel_path, f.saved_at])).toEqual([
      ['audit_trail', 'saved', `contract-files/${subject.id}/contract-${subject.id}-audit-trail.pdf`, '2026-01-05 09:00:00'],
      ['signed_pdf', 'saved', `contract-files/${subject.id}/contract-${subject.id}-signed.pdf`, '2026-01-05 09:00:00'],
    ]);
  });

  it('保存失敗的紀錄也轉入', () => {
    const subject = legacyContract('completed', '470');
    legacyFile(subject, 'audit_trail', { status: 'failed', error: '下載連結回應 403' });
    upgrade();

    const files = listSignTaskFiles(db, findSignTask(db, subject)!.id);
    expect(files.map((f) => [f.kind, f.status, f.error])).toEqual([['audit_trail', 'failed', '下載連結回應 403']]);
  });

  it('合約文件對不到簽署任務時略過，不擋住開檔', () => {
    const subject = legacyContract('completed', null);
    legacyFile(subject, 'signed_pdf', { status: 'saved' });

    expect(upgrade).not.toThrow();
    expect(db.prepare('SELECT count(*) AS n FROM sign_task_files').get()).toEqual({ n: 0 });
  });
});

describe('回填遇到壞資料', () => {
  it('合約欄位不是合法 JSON 時略過該列，其他合約照常回填，不擋住開檔', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = legacyContract('awaiting_tenant', 'mock-1-a', '{not json');
    const good = legacyContract('awaiting_tenant', 'mock-2-b');

    expect(upgrade).not.toThrow();

    expect(progressOf(broken)).toBeNull();
    expect(progressOf(good)).toMatchObject({ status: 'in_progress' });
  });

  it('兩份合約共用任務編號時，第二份略過，不擋住開檔', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = legacyContract('awaiting_tenant', '470');
    const second = legacyContract('awaiting_tenant', '470');

    expect(upgrade).not.toThrow();

    expect(progressOf(first)).toMatchObject({ status: 'in_progress' });
    expect(progressOf(second)).toBeNull();
  });

  it('合約欄位缺簽署人資料，或簽署人欄位不是字串時，姓名與 email 記為空字串', () => {
    const missing = legacyContract('awaiting_tenant', 'mock-1-a', '{}');
    const odd = legacyContract('awaiting_tenant', 'mock-2-b', JSON.stringify({ tenantName: { a: 1 }, tenantEmail: 7 }));

    expect(upgrade).not.toThrow();

    expect(progressOf(missing)?.currentSigner).toEqual({ role: 'party_b', name: '', email: '' });
    expect(progressOf(odd)?.currentSigner).toEqual({ role: 'party_b', name: '', email: '' });
  });
});

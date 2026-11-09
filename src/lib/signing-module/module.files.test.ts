import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContractSubscriber } from '../contract-signing';
import { getContract } from '../contracts';
import { sha256Hex, type FileStore } from '../file-store';
import { createLocalFileStore } from '../file-store/local-file-store';
import { parseObjectKey } from '../file-store/object-key';
import { withTx } from '../pg/database';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import type { ContractFields } from '../types';
import type { SigningDb } from './db';
import { createMockProvider } from './mock-adapter';
import { createSigningModule } from './module';
import { OUTBOX_MAX_RETRIES } from './outbox';
import type { SignableDocument, Signer, SigningProvider } from './provider';

// 文件保存走 FileStore 與 outbox（MIL-87，ADR-0020）。走簽署模組介面，PGlite 加本機 FileStore。

let kit: RouteDb;
let dataDir: string;
let files: FileStore;

beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());

beforeEach(async () => {
  await kit.reset();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signing-files-'));
  files = createLocalFileStore(dataDir);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const inOrg = <T,>(orgId: string, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId }, fn);

const dbFor = (orgId: string): SigningDb => ({
  requestOrg: async () => ({ kind: 'org', orgId }),
  inOrg: (ctx, fn) => withTx(ctx, fn),
  inControl: (fn) => withTx({ kind: 'control' }, fn),
});

const moduleWith = (provider: SigningProvider, orgId = kit.orgA, store: FileStore = files) =>
  createSigningModule({
    provider,
    subscribers: { contract: createContractSubscriber() },
    files: store,
    db: dbFor(orgId),
  });

const bytesOf = (text: string) => new TextEncoder().encode(text);
const textOf = (data: Uint8Array | null) => (data ? new TextDecoder().decode(data) : null);

// webhook 一送來就是全員完成
const completedProvider = (taskRef: string, overrides: Partial<SigningProvider> = {}): SigningProvider => ({
  id: 'dottedsign',
  mode: 'live',
  unsupported: { simulate: 'live 模式下請走真實 webhook' },
  createTask: async () => ({ taskRef }),
  getSignLink: async () => 'https://sign.example/abc',
  resend: async () => {},
  voidTask: async () => {},
  downloadFile: async (ref, kind) => bytesOf(`${kind}-of-${ref}`),
  parseWebhook: () => ({ kind: 'event', taskRef, event: { type: 'completed' } }),
  ...overrides,
});

const FIELDS = {
  landlordName: '林房東',
  landlordEmail: 'landlord@example.com',
  tenantName: '王租客',
  tenantEmail: 'tenant@example.com',
} as ContractFields;

async function newDraft(orgId = kit.orgA) {
  const id = newUlid();
  await inOrg(orgId, (tx) =>
    tx.query(`INSERT INTO org.contracts (id, org_id, fields) VALUES ($1, current_setting('app.org_id', true), $2::jsonb)`, [
      id,
      JSON.stringify(FIELDS),
    ]),
  );
  return { type: 'contract', id } as const;
}

const document: SignableDocument = {
  fileName: '租賃合約-測試物件',
  pdf: new Uint8Array([37, 80, 68, 70]),
  pageSize: { width: 595.28, height: 841.89 },
};
const signers: Signer[] = [
  { role: 'party_b', name: '王租客', email: 'tenant@example.com', signatureFields: [] },
  { role: 'party_a', name: '林房東', email: 'landlord@example.com', signatureFields: [] },
];

const statusOf = async (id: string, orgId = kit.orgA) => (await inOrg(orgId, (tx) => getContract(tx, id)))?.status;

interface FileRowView {
  kind: string;
  status: string;
  object_key: string | null;
  sha256: string | null;
  byte_size: number | null;
  error: string | null;
}
const fileRows = (orgId = kit.orgA) =>
  inOrg(orgId, async (tx) => {
    const { rows } = await tx.query<FileRowView>(
      'SELECT kind, status, object_key, sha256, byte_size, error FROM org.sign_task_files ORDER BY kind',
    );
    return rows;
  });
const saveOutbox = (orgId = kit.orgA) =>
  inOrg(orgId, async (tx) => {
    const { rows } = await tx.query<{ status: string; attempts: number; last_error: string | null }>(
      "SELECT status, attempts, last_error FROM org.outbox WHERE action = 'save_sign_task_files' ORDER BY id",
    );
    return rows;
  });

async function completed(provider: SigningProvider, orgId = kit.orgA, store: FileStore = files) {
  const subject = await newDraft(orgId);
  const signing = moduleWith(provider, orgId, store);
  await signing.send(subject, document, signers);
  const ack = await signing.ingestWebhook('{}', new Headers());
  return { subject, signing, ack };
}

describe('文件表存物件 key 與 SHA-256', () => {
  it('完成後兩份文件都在 FileStore，文件表記 key、SHA-256、大小，沒有本機路徑', async () => {
    const { subject } = await completed(completedProvider('task-1'));

    const rows = await fileRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('saved');
      expect(row.object_key).toMatch(new RegExp(`^org/${kit.orgA}/sign-tasks/[0-9A-Z]{26}/`));
      expect(row.object_key).not.toContain(dataDir);
      const stored = await files.read(parseObjectKey(row.object_key as string));
      expect(row.sha256).toBe(sha256Hex(stored as Uint8Array));
      expect(row.byte_size).toBe(stored?.length);
    }
    expect(textOf(await files.read(parseObjectKey(rows.find((r) => r.kind === 'signed_pdf')!.object_key as string)))).toBe(
      'signed_pdf-of-task-1',
    );
    expect(await statusOf(subject.id)).toBe('completed');
  });

  it('不同組織的文件放在各自的前綴下，不會撞名', async () => {
    await completed(completedProvider('task-a'), kit.orgA);
    await completed(completedProvider('task-b'), kit.orgB);

    const keysA = (await fileRows(kit.orgA)).map((r) => r.object_key);
    const keysB = (await fileRows(kit.orgB)).map((r) => r.object_key);
    expect(keysA.every((k) => k?.startsWith(`org/${kit.orgA}/`))).toBe(true);
    expect(keysB.every((k) => k?.startsWith(`org/${kit.orgB}/`))).toBe(true);
    expect(keysA.filter((k) => keysB.includes(k))).toEqual([]);
  });

  it('資料庫擋下前綴不是自己組織的 key', async () => {
    const { subject } = await completed(completedProvider('task-1'));
    const wrongOrgKey = `org/${kit.orgB}/sign-tasks/x/y.pdf`;
    await expect(
      inOrg(kit.orgA, (tx) =>
        tx.query("UPDATE org.sign_task_files SET object_key = $1 WHERE kind = 'signed_pdf'", [wrongOrgKey]),
      ),
    ).rejects.toThrow(/sign_task_files_key_has_org/);
    expect(subject.id).toBeTruthy();
  });

  it('saved 的列必須有 key 與 SHA-256', async () => {
    await completed(completedProvider('task-1'));
    await expect(
      inOrg(kit.orgA, (tx) => tx.query("UPDATE org.sign_task_files SET sha256 = NULL WHERE kind = 'signed_pdf'")),
    ).rejects.toThrow(/sign_task_files_saved_complete/);
  });

  it('mock 模式仍能產生已簽 PDF，內容是送簽時的 PDF', async () => {
    const subject = await newDraft();
    const signing = moduleWith(createMockProvider());
    await signing.send(subject, document, signers);
    await signing.simulateEvent(subject, 'completed');

    const downloaded = await signing.downloadFile(subject, 'signed_pdf');
    expect(Array.from(downloaded.bytes)).toEqual(Array.from(document.pdf));
    const rows = await fileRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'signed_pdf', status: 'saved', sha256: sha256Hex(document.pdf) });
  });
});

describe('保存走 outbox', () => {
  it('完成時 outbox 列與完成狀態同交易寫入，提交後派送一次並標完成', async () => {
    const download = vi.fn(async (ref: string, kind: string) => bytesOf(`${kind}-of-${ref}`));
    await completed(completedProvider('task-1', { downloadFile: download }));
    expect(await saveOutbox()).toEqual([{ status: 'done', attempts: 1, last_error: null }]);
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('下載失敗：webhook 仍回 200，合約維持已完成，outbox 留 pending 等重試，失敗原因進文件紀錄', async () => {
    const provider = completedProvider('task-1', {
      downloadFile: async () => {
        throw new Error('下載連結回應 503');
      },
    });
    const { subject, ack } = await completed(provider);

    expect(ack).toEqual({ status: 200, body: { ok: true } });
    expect(await statusOf(subject.id)).toBe('completed');
    expect(await saveOutbox()).toEqual([
      { status: 'pending', attempts: 1, last_error: expect.stringContaining('下載連結回應 503') },
    ]);
    const rows = await fileRows();
    expect(rows.map((r) => [r.kind, r.status, r.error])).toEqual([
      ['audit_trail', 'failed', '下載連結回應 503'],
      ['signed_pdf', 'failed', '下載連結回應 503'],
    ]);
  });

  it('FileStore 寫入失敗也一樣：回 200，狀態不回滾，留待重試', async () => {
    const broken: FileStore = {
      ...files,
      write: async () => {
        throw new Error('Cloud Storage 403');
      },
    };
    const { subject, ack } = await completed(completedProvider('task-1'), kit.orgA, broken);

    expect(ack.status).toBe(200);
    expect(await statusOf(subject.id)).toBe('completed');
    expect((await saveOutbox())[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect((await fileRows()).map((r) => r.error)).toEqual(['Cloud Storage 403', 'Cloud Storage 403']);
  });

  it('排程重試成功：補上沒保存的文件，列標完成，已保存的不重抓', async () => {
    let failAudit = true;
    const download = vi.fn(async (ref: string, kind: string) => {
      if (kind === 'audit_trail' && failAudit) throw new Error('下載連結回應 503');
      return bytesOf(`${kind}-of-${ref}`);
    });
    const provider = completedProvider('task-1', { downloadFile: download });
    const { signing } = await completed(provider);
    expect((await saveOutbox())[0].status).toBe('pending');
    expect(download.mock.calls.map((c) => c[1])).toEqual(['signed_pdf', 'audit_trail']);

    failAudit = false;
    expect(await signing.drainOutbox(kit.orgA, 10)).toEqual([{ kind: 'done' }]);

    expect(download.mock.calls.map((c) => c[1])).toEqual(['signed_pdf', 'audit_trail', 'audit_trail']);
    expect((await fileRows()).map((r) => r.status)).toEqual(['saved', 'saved']);
    expect(await saveOutbox()).toEqual([{ status: 'done', attempts: 2, last_error: null }]);
  });

  it(`重試上限 ${OUTBOX_MAX_RETRIES} 次：用完轉 dead，合約維持已完成`, async () => {
    const provider = completedProvider('task-1', {
      downloadFile: async () => {
        throw new Error('下載連結回應 503');
      },
    });
    const { subject, signing } = await completed(provider);

    for (let retry = 1; retry <= OUTBOX_MAX_RETRIES; retry++) {
      const [result] = await signing.drainOutbox(kit.orgA, 10);
      expect(result).toMatchObject({ kind: 'failed', status: retry === OUTBOX_MAX_RETRIES ? 'dead' : 'pending' });
    }

    expect(await saveOutbox()).toEqual([
      { status: 'dead', attempts: OUTBOX_MAX_RETRIES + 1, last_error: expect.stringContaining('下載連結回應 503') },
    ]);
    expect(await signing.drainOutbox(kit.orgA, 10)).toEqual([]);
    expect(await statusOf(subject.id)).toBe('completed');
  });

  it('提交後、派送前程序中斷：outbox 列仍在，之後的排程把文件補上', async () => {
    // 派送之前的唯一差別是第一次派送沒有發生。用一個永遠不派送的 FileStore 包裝模擬：
    // 第一次寫入前先讓程序「中斷」，也就是丟出 AbortError 之外的例外都不會影響列的存在
    let calls = 0;
    const flaky: FileStore = {
      ...files,
      write: async (key, data, meta) => {
        if (calls++ < 2) throw new Error('程序被終止');
        return files.write(key, data, meta);
      },
    };
    const { signing } = await completed(completedProvider('task-1'), kit.orgA, flaky);
    expect((await saveOutbox())[0].status).toBe('pending');

    expect(await signing.drainOutbox(kit.orgA, 10)).toEqual([{ kind: 'done' }]);
    expect((await fileRows()).map((r) => r.status)).toEqual(['saved', 'saved']);
  });

  it('停在 sending 太久的保存列由排程轉回 pending 再重試', async () => {
    const { signing } = await completed(completedProvider('task-1'));
    // 製造派送中斷：把完成的列改回 sending 並調舊 updated_at，文件紀錄清空
    await inOrg(kit.orgA, async (tx) => {
      await tx.query(
        `UPDATE org.outbox SET status = 'sending', updated_at = now() - interval '1 hour', completed_at = NULL
          WHERE action = 'save_sign_task_files'`,
      );
      await tx.query('DELETE FROM org.sign_task_files');
    });

    expect(await signing.drainOutbox(kit.orgA, 10)).toEqual([{ kind: 'done' }]);
    expect((await fileRows()).map((r) => r.status)).toEqual(['saved', 'saved']);
  });
});

describe('下載與補抓行為不變', () => {
  it('檔案被刪掉時當場補抓一次', async () => {
    const download = vi.fn(async (ref: string, kind: string) => bytesOf(`${kind}-of-${ref}`));
    const { subject, signing } = await completed(completedProvider('task-1', { downloadFile: download }));
    fs.rmSync(path.join(dataDir, 'org'), { recursive: true, force: true });

    expect(textOf((await signing.downloadFile(subject, 'signed_pdf')).bytes)).toBe('signed_pdf-of-task-1');
    expect(download).toHaveBeenCalledTimes(3);
  });

  it('檔案內容與紀錄的 SHA-256 不符時，視為未保存並重新取得', async () => {
    const download = vi.fn(async (ref: string, kind: string) => bytesOf(`${kind}-of-${ref}`));
    const { subject, signing } = await completed(completedProvider('task-1', { downloadFile: download }));
    const signed = (await fileRows()).find((r) => r.kind === 'signed_pdf')!;
    await files.write(parseObjectKey(signed.object_key as string), bytesOf('被竄改的內容'), { contentType: 'application/pdf' });

    expect(textOf((await signing.downloadFile(subject, 'signed_pdf')).bytes)).toBe('signed_pdf-of-task-1');
    expect(download).toHaveBeenCalledTimes(3);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('SHA-256 不符'));
  });

  it('另一個模組實例（換實例）也讀得到已保存的文件，不必向服務商重抓', async () => {
    const { subject } = await completed(completedProvider('task-1'));
    const download = vi.fn(async () => bytesOf('不該被呼叫'));
    const another = moduleWith(completedProvider('task-1', { downloadFile: download }), kit.orgA, createLocalFileStore(dataDir));

    expect(textOf((await another.downloadFile(subject, 'signed_pdf')).bytes)).toBe('signed_pdf-of-task-1');
    expect(download).not.toHaveBeenCalled();
  });

  it('FileStore 讀取失敗（不是不存在）回 502，不覆蓋文件紀錄', async () => {
    const { subject } = await completed(completedProvider('task-1'));
    const unreadable: FileStore = {
      ...files,
      read: async () => {
        throw new Error('Permission denied');
      },
    };
    const reader = moduleWith(completedProvider('task-1'), kit.orgA, unreadable);

    await expect(reader.downloadFile(subject, 'signed_pdf')).rejects.toThrow('Permission denied');
    expect((await fileRows()).map((r) => r.status)).toEqual(['saved', 'saved']);
  });

  it('手動補抓（force）會覆蓋已保存的文件並更新 SHA-256', async () => {
    let version = 1;
    const provider = completedProvider('task-1', { downloadFile: async (_r, kind) => bytesOf(`${kind}-v${version}`) });
    const { subject, signing } = await completed(provider);
    version = 2;

    await signing.saveFiles(subject, { force: true });

    const signed = (await fileRows()).find((r) => r.kind === 'signed_pdf')!;
    expect(signed.sha256).toBe(sha256Hex(bytesOf('signed_pdf-v2')));
    expect(textOf((await signing.downloadFile(subject, 'signed_pdf')).bytes)).toBe('signed_pdf-v2');
  });
});

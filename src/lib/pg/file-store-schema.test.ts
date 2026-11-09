import { PGlite } from '@electric-sql/pglite';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from './migrate';
import { MIGRATIONS_DIR } from './test-harness';
import { newUlid } from './ulid';

// MIL-87 的 migration 0008：舊的 saved 文件列（只有本機路徑）轉成 failed，之後的新格式受約束保護。
// 用「先跑到 0007 之前、塞舊資料、再跑 0008」的順序驗證，所以不用共用的 harness。

describe('0008_file_store：舊資料升級', () => {
  let db: PGlite;
  let dir: string;
  const orgId = newUlid();
  const taskId = newUlid();

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'file-store-migration-'));
    const all = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const before = all.filter((f) => f < '0008');
    for (const f of before) await copyFile(path.join(MIGRATIONS_DIR, f), path.join(dir, f));

    db = new PGlite();
    await db.waitReady;
    await migrate(db, { dir, runAs: 'app_owner' });

    // postgres（超級使用者）繞過 RLS，直接塞升級前的資料
    await db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner')`, [orgId]);
    await db.query(
      `INSERT INTO org.sign_tasks (id, org_id, provider, provider_task_ref, subject_type, subject_id)
       VALUES ($1, $2, 'mock', 'old-task', 'contract', $3)`,
      [taskId, orgId, newUlid()],
    );
    await db.query(
      `INSERT INTO org.sign_task_files (id, org_id, sign_task_id, kind, status, file_name, rel_path, byte_size, content_type)
       VALUES ($1, $2, $3, 'signed_pdf', 'saved', 'old.pdf', 'sign-task-files/x/old.pdf', 10, 'application/pdf'),
              ($4, $2, $3, 'audit_trail', 'failed', 'old-audit.pdf', NULL, NULL, NULL)`,
      [newUlid(), orgId, taskId, newUlid()],
    );

    for (const f of all.filter((f) => f >= '0008')) await copyFile(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    await migrate(db, { dir, runAs: 'app_owner' });
  });

  afterAll(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('舊的 saved 列轉成 failed，寫明原因，清掉本機路徑留下的大小與類型', async () => {
    const { rows } = await db.query<{ kind: string; status: string; error: string | null; byte_size: number | null; object_key: string | null }>(
      'SELECT kind, status, error, byte_size, object_key FROM org.sign_task_files ORDER BY kind',
    );
    expect(rows).toEqual([
      { kind: 'audit_trail', status: 'failed', error: null, byte_size: null, object_key: null },
      {
        kind: 'signed_pdf',
        status: 'failed',
        error: '舊版本機路徑，尚未存進 FileStore，下載時會重新向簽署服務商取得',
        byte_size: null,
        object_key: null,
      },
    ]);
  });

  it('rel_path 欄位已移除', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'org' AND table_name = 'sign_task_files'",
    );
    const names = rows.map((r) => r.column_name);
    expect(names).not.toContain('rel_path');
    expect(names).toEqual(expect.arrayContaining(['object_key', 'sha256']));
  });

  it('升級後 FORCE RLS 仍然有效', async () => {
    const { rows } = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'org.sign_task_files'::regclass",
    );
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('outbox 接受 save_sign_task_files，仍擋下未知的 action', async () => {
    await db.query(
      `INSERT INTO org.outbox (id, org_id, action, subject_type, subject_id) VALUES ($1, $2, 'save_sign_task_files', 'contract', $3)`,
      [newUlid(), orgId, newUlid()],
    );
    await expect(
      db.query(`INSERT INTO org.outbox (id, org_id, action, subject_type, subject_id) VALUES ($1, $2, 'bogus', 'contract', $3)`, [
        newUlid(),
        orgId,
        newUlid(),
      ]),
    ).rejects.toThrow(/outbox_action_check/);
  });

  it('SHA-256 格式受約束', async () => {
    await expect(
      db.query(
        `INSERT INTO org.sign_task_files (id, org_id, sign_task_id, kind, status, file_name, object_key, sha256, byte_size)
         VALUES ($1, $2, $3, 'signed_pdf', 'saved', 'x.pdf', $4, 'not-a-hash', 1)
         ON CONFLICT (org_id, sign_task_id, kind) DO UPDATE SET sha256 = excluded.sha256`,
        [newUlid(), orgId, taskId, `org/${orgId}/sign-tasks/${taskId}/x.pdf`],
      ),
    ).rejects.toThrow(/sign_task_files_sha256_format/);
  });
});

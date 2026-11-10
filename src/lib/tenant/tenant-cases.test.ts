import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Forbidden } from '../authorize';
import { findOrCreateParty } from '../case-store';
import { buildObjectKey, sha256Hex, type FileStore } from '../file-store';
import { createLocalFileStore } from '../file-store/local-file-store';
import { withTx } from '../pg/database';
import { setupRouteDb, TEST_USER_ID, type RouteDb } from '../pg/route-test-kit';
import { newUlid } from '../pg/ulid';
import type { RequestContext } from '../request-context';
import { listTenantCases, loadSignedPdf, loadTenantCaseDetail } from './index';

// 承租人端的讀取（MIL-121）：我的案件、案件詳情、下載已簽 PDF。
// 連線是 PGlite 的 app_rw，RLS 生效。接縫是 src/lib/tenant 的三個函式，加上資料庫的成員讀取政策。

let kit: RouteDb;
let dataDir: string;
let files: FileStore;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(async () => {
  await kit.reset();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-files-'));
  files = createLocalFileStore(dataDir);
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const PAST = new Date('2026-01-01T00:00:00.000Z');
const PDF = new TextEncoder().encode('%PDF-已簽合約');

type PartyRc = Extract<RequestContext, { kind: 'party' }>;
const asParty = (partyId: string): PartyRc => ({ kind: 'party', userId: TEST_USER_ID, partyId, requestId: 't' });

interface SeedOptions {
  orgId?: string;
  title?: string;
  state?: string;
  contractStatus?: string | null;
  /** 已簽 PDF：saved 並真的寫進 FileStore；failed 只記錄；null 沒有紀錄。 */
  file?: 'saved' | 'failed' | 'saved_but_missing' | 'saved_but_tampered' | null;
  members?: Array<{ email: string; name: string; relation: 'lessor' | 'lessee' | 'co_lessee' | 'owner'; closed?: boolean }>;
}

/** 直接寫入案件、合約、簽署任務與已簽檔案。回傳案件 ID。 */
async function seedCase(options: SeedOptions = {}): Promise<{ caseId: string; contractId: string | null }> {
  const orgId = options.orgId ?? kit.orgA;
  const caseId = newUlid();
  const contractStatus = options.contractStatus === undefined ? 'completed' : options.contractStatus;
  const contractId = contractStatus ? newUlid() : null;
  await withTx({ kind: 'org', orgId }, async (tx) => {
    await tx.query(
      `INSERT INTO org.cases (id, org_id, kind, state, business_type, title, lease_start, lease_end, monthly_rent)
       VALUES ($1, $2, 'lease', $3, 'self_managed', $4, '2026-01-01', '2026-12-31', 20000)`,
      [caseId, orgId, options.state ?? 'active', options.title ?? '測試案件'],
    );
    if (contractId) {
      await tx.query(`INSERT INTO org.contracts (id, org_id, case_id, status) VALUES ($1, $2, $3, $4)`, [contractId, orgId, caseId, contractStatus]);
      await tx.query(`UPDATE org.cases SET current_contract_id = $2 WHERE id = $1`, [caseId, contractId]);
    }
    for (const m of options.members ?? []) {
      const partyId = await findOrCreateParty(tx, m.email, m.name);
      await tx.query(
        `INSERT INTO org.case_members (id, org_id, case_id, party_id, relation, valid_period) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          newUlid(),
          orgId,
          caseId,
          partyId,
          m.relation,
          m.closed
            ? `[${PAST.toISOString()},2026-02-01T00:00:00Z)`
            : `[${PAST.toISOString()},)`,
        ],
      );
    }
    if (contractId && options.file) {
      const taskId = newUlid();
      await tx.query(
        `INSERT INTO org.sign_tasks (id, org_id, provider, provider_task_ref, subject_type, subject_id)
         VALUES ($1, $2, 'mock', $3, 'contract', $4)`,
        [taskId, orgId, `ref-${taskId}`, contractId],
      );
      if (options.file === 'failed') {
        await tx.query(
          `INSERT INTO org.sign_task_files (id, org_id, sign_task_id, kind, status, file_name, error) VALUES ($1, $2, $3, 'signed_pdf', 'failed', 'x.pdf', '失敗')`,
          [newUlid(), orgId, taskId],
        );
      } else {
        const key = buildObjectKey(orgId, 'sign-tasks', taskId, 'signed.pdf');
        const sha = options.file === 'saved_but_tampered' ? 'f'.repeat(64) : sha256Hex(PDF);
        if (options.file !== 'saved_but_missing') await files.write(key, options.file === 'saved_but_tampered' ? new TextEncoder().encode('被改過') : PDF, { contentType: 'application/pdf' });
        await tx.query(
          `INSERT INTO org.sign_task_files (id, org_id, sign_task_id, kind, status, file_name, object_key, sha256, byte_size, content_type)
           VALUES ($1, $2, $3, 'signed_pdf', 'saved', '租賃契約書.pdf', $4, $5, $6, 'application/pdf')`,
          [newUlid(), orgId, taskId, key, sha, PDF.byteLength],
        );
        // Audit Trail File 也存在，承租人不得讀
        await tx.query(
          `INSERT INTO org.sign_task_files (id, org_id, sign_task_id, kind, status, file_name, object_key, sha256, byte_size, content_type)
           VALUES ($1, $2, $3, 'audit_trail', 'saved', 'audit.pdf', $4, $5, 1, 'application/pdf')`,
          [newUlid(), orgId, taskId, buildObjectKey(orgId, 'sign-tasks', taskId, 'audit.pdf'), sha],
        );
      }
    }
  });
  return { caseId, contractId };
}

async function partyIdOf(email: string): Promise<string> {
  return withTx({ kind: 'control' }, async (tx) => (await tx.query<{ id: string }>('SELECT id FROM control.parties WHERE email = $1', [email])).rows[0].id);
}

const TENANT = { email: 'tenant@example.com', name: '王租客', relation: 'lessee' as const };
const LESSOR = { email: 'lessor@example.com', name: '陳出租人', relation: 'lessor' as const };

describe('listTenantCases：我的案件', () => {
  it('兩個組織的案件都列出，新的在前，帶組織名稱、狀態、租期與合約狀態（P0-21 AC1）', async () => {
    const a = await seedCase({ orgId: kit.orgA, title: 'A 的物件', file: 'saved', members: [LESSOR, TENANT] });
    const b = await seedCase({ orgId: kit.orgB, title: 'B 的物件', state: 'closed', file: null, members: [{ ...LESSOR, email: 'lessor-b@example.com' }, TENANT] });
    const rows = await listTenantCases(asParty(await partyIdOf(TENANT.email)));
    expect(rows.map((r) => r.id)).toEqual([b.caseId, a.caseId]);
    expect(rows[1]).toMatchObject({
      title: 'A 的物件',
      orgName: 'A 組織',
      state: 'active',
      contractStatus: 'completed',
      leaseStart: '2026-01-01',
      leaseEnd: '2026-12-31',
      monthlyRent: 20000,
      relation: 'lessee',
      caseKind: 'lease',
    });
    expect(rows[0]).toMatchObject({ orgName: 'B 組織', state: 'closed' });
  });

  it('結案的案件仍然列出（P0-09 AC6）', async () => {
    await seedCase({ state: 'closed', members: [LESSOR, TENANT], file: 'saved' });
    const rows = await listTenantCases(asParty(await partyIdOf(TENANT.email)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'closed', contractStatus: 'completed' });
  });

  it('email 不屬於任何案件：空陣列', async () => {
    await seedCase({ members: [LESSOR, TENANT] });
    const stranger = newUlid();
    await withTx({ kind: 'control' }, (tx) => tx.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'nobody@example.com', 'n')`, [stranger]));
    expect(await listTenantCases(asParty(stranger))).toEqual([]);
  });

  it('只是出租人的 party 沒有承租人端的案件；共同承租人有', async () => {
    await seedCase({ members: [LESSOR, TENANT, { email: 'co@example.com', name: '共同', relation: 'co_lessee' }] });
    expect(await listTenantCases(asParty(await partyIdOf(LESSOR.email)))).toEqual([]);
    const co = await listTenantCases(asParty(await partyIdOf('co@example.com')));
    expect(co).toHaveLength(1);
    expect(co[0].relation).toBe('co_lessee');
  });

  it('成員關係已關閉的案件不列出', async () => {
    await seedCase({ members: [LESSOR, { ...TENANT, closed: true }] });
    expect(await listTenantCases(asParty(await partyIdOf(TENANT.email)))).toEqual([]);
  });

  it('別人的案件不列出（P0-09 AC1）', async () => {
    await seedCase({ title: '別人的', members: [{ ...LESSOR, email: 'l2@example.com' }, { email: 'other@example.com', name: '別人', relation: 'lessee' }] });
    const mine = await seedCase({ title: '我的', members: [LESSOR, TENANT] });
    const rows = await listTenantCases(asParty(await partyIdOf(TENANT.email)));
    expect(rows.map((r) => r.id)).toEqual([mine.caseId]);
  });

  it('回傳內容不含 email 與其他成員的資料', async () => {
    await seedCase({ members: [LESSOR, TENANT] });
    const json = JSON.stringify(await listTenantCases(asParty(await partyIdOf(TENANT.email))));
    expect(json).not.toContain('lessor@example.com');
    expect(json).not.toContain('tenant@example.com');
  });
});

describe('loadTenantCaseDetail：案件詳情', () => {
  it('成員讀到案件、合約狀態、出租人名稱、自己的關係與已簽 PDF 是否可下載', async () => {
    const { caseId } = await seedCase({ file: 'saved', members: [LESSOR, TENANT] });
    const detail = await loadTenantCaseDetail(asParty(await partyIdOf(TENANT.email)), caseId);
    expect(detail).toMatchObject({
      id: caseId,
      title: '測試案件',
      orgName: 'A 組織',
      state: 'active',
      relation: 'lessee',
      lessorNames: ['陳出租人'],
      contract: { status: 'completed', hasSignedPdf: true },
      leaseStart: '2026-01-01',
      monthlyRent: 20000,
      caseKind: 'lease',
    });
    const json = JSON.stringify(detail);
    expect(json).not.toContain('lessor@example.com');
    expect(json).not.toContain('tenant@example.com');
  });

  it('沒有合約（後繼案件）時 contract 是 null', async () => {
    const { caseId } = await seedCase({ contractStatus: null, members: [LESSOR, TENANT] });
    const detail = await loadTenantCaseDetail(asParty(await partyIdOf(TENANT.email)), caseId);
    expect(detail.contract).toBeNull();
  });

  it('結案後仍讀得到（唯讀）', async () => {
    const { caseId } = await seedCase({ state: 'closed', members: [LESSOR, TENANT] });
    expect((await loadTenantCaseDetail(asParty(await partyIdOf(TENANT.email)), caseId)).state).toBe('closed');
  });

  it('別人的案件與不存在的案件：同樣丟 Forbidden（P0-09 AC1）', async () => {
    const other = await seedCase({ members: [{ ...LESSOR, email: 'l2@example.com' }, { email: 'other@example.com', name: '別人', relation: 'lessee' }] });
    await seedCase({ members: [LESSOR, TENANT] });
    const rc = asParty(await partyIdOf(TENANT.email));
    const notMember = await loadTenantCaseDetail(rc, other.caseId).catch((e) => e);
    const missing = await loadTenantCaseDetail(rc, newUlid()).catch((e) => e);
    expect(notMember).toBeInstanceOf(Forbidden);
    expect(missing).toBeInstanceOf(Forbidden);
    expect(notMember.message).toBe(missing.message);
    expect(notMember.object).toMatchObject({ type: 'case' });
  });

  it('只是出租人的 party 走承租人端也讀不到', async () => {
    const { caseId } = await seedCase({ members: [LESSOR, TENANT] });
    await expect(loadTenantCaseDetail(asParty(await partyIdOf(LESSOR.email)), caseId)).rejects.toBeInstanceOf(Forbidden);
  });

  it('成員關係已關閉：與不是成員相同', async () => {
    const { caseId } = await seedCase({ members: [LESSOR, { ...TENANT, closed: true }] });
    await expect(loadTenantCaseDetail(asParty(await partyIdOf(TENANT.email)), caseId)).rejects.toBeInstanceOf(Forbidden);
  });
});

describe('loadSignedPdf：下載已簽合約', () => {
  it('成員取得已簽 PDF 的位元組與檔名', async () => {
    const { caseId } = await seedCase({ file: 'saved', members: [LESSOR, TENANT] });
    const result = await loadSignedPdf(asParty(await partyIdOf(TENANT.email)), caseId, files);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new TextDecoder().decode(result.bytes)).toBe('%PDF-已簽合約');
    expect(result).toMatchObject({ fileName: '租賃契約書.pdf', contentType: 'application/pdf' });
  });

  it('結案後仍能下載（P0-09 AC6）', async () => {
    const { caseId } = await seedCase({ state: 'closed', file: 'saved', members: [LESSOR, TENANT] });
    expect((await loadSignedPdf(asParty(await partyIdOf(TENANT.email)), caseId, files)).ok).toBe(true);
  });

  it('共同承租人能下載', async () => {
    const { caseId } = await seedCase({ file: 'saved', members: [LESSOR, TENANT, { email: 'co@example.com', name: '共同', relation: 'co_lessee' }] });
    expect((await loadSignedPdf(asParty(await partyIdOf('co@example.com')), caseId, files)).ok).toBe(true);
  });

  it('合約還沒完成簽署：回 not_completed', async () => {
    const { caseId } = await seedCase({ contractStatus: 'awaiting_landlord', file: null, members: [LESSOR, TENANT] });
    expect(await loadSignedPdf(asParty(await partyIdOf(TENANT.email)), caseId, files)).toEqual({ ok: false, reason: 'not_completed' });
  });

  it.each(['failed', 'saved_but_missing', 'saved_but_tampered', null] as const)('檔案狀態 %s：回 not_available，不丟錯', async (file) => {
    const { caseId } = await seedCase({ file, members: [LESSOR, TENANT] });
    expect(await loadSignedPdf(asParty(await partyIdOf(TENANT.email)), caseId, files)).toEqual({ ok: false, reason: 'not_available' });
  });

  it('只是出租人的 party 走承租人端也下載不到', async () => {
    const { caseId } = await seedCase({ file: 'saved', members: [LESSOR, TENANT] });
    await expect(loadSignedPdf(asParty(await partyIdOf(LESSOR.email)), caseId, files)).rejects.toBeInstanceOf(Forbidden);
  });

  it('別人的案件與不存在的案件：丟 Forbidden', async () => {
    const other = await seedCase({ file: 'saved', members: [{ ...LESSOR, email: 'l2@example.com' }, { email: 'other@example.com', name: '別人', relation: 'lessee' }] });
    await seedCase({ file: 'saved', members: [LESSOR, TENANT] });
    const rc = asParty(await partyIdOf(TENANT.email));
    await expect(loadSignedPdf(rc, other.caseId, files)).rejects.toBeInstanceOf(Forbidden);
    await expect(loadSignedPdf(rc, newUlid(), files)).rejects.toBeInstanceOf(Forbidden);
  });
});

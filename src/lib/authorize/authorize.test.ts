import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTx } from '../pg/database';
import { setupRouteDb, TEST_PARTY_ID, TEST_USER_ID, type RouteDb } from '../pg/route-test-kit';
import { newUlid } from '../pg/ulid';
import { createProperty, parsePropertyInput } from '../properties';
import type { OrgRole, RequestContext } from '../request-context';
import { authorize, authorizeAuditExport, bindAccessContext, checkAccess, Forbidden, type AuthObject } from './index';

// authorize() 的行為測試（MIL-108）。連線是 PGlite 的 app_rw，RLS 生效。
// 接縫是 authorize 與 checkAccess 的公開介面，不測內部怎麼載入事實。

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(() => kit.reset());

const orgContext = (orgId: string, role: OrgRole): Extract<RequestContext, { kind: 'org' }> => ({
  kind: 'org',
  orgId,
  orgKind: 'owner',
  userId: TEST_USER_ID,
  partyId: TEST_PARTY_ID,
  role,
  requestId: 'test',
});

/** 以指定組織與角色開交易，綁上脈絡後執行。 */
function asRole_<R>(orgId: string, role: OrgRole, fn: (tx: Parameters<typeof authorize>[0]) => Promise<R>): Promise<R> {
  const rc = orgContext(orgId, role);
  return withTx({ kind: 'org', orgId, partyId: rc.partyId }, (tx) => {
    bindAccessContext(tx, rc);
    return fn(tx);
  });
}

async function seedProperty(orgId: string): Promise<string> {
  const parsed = parsePropertyInput({ name: '測試物件', address: '台北市大安區和平東路二段 100 號 3 樓', type: '整層住家' });
  if (!parsed.ok) throw new Error(parsed.error);
  return withTx({ kind: 'org', orgId }, (tx) => createProperty(tx, parsed.value));
}

async function seedContract(orgId: string): Promise<string> {
  const id = newUlid();
  await withTx({ kind: 'org', orgId }, (tx) => tx.query(`INSERT INTO org.contracts (id, org_id) VALUES ($1, $2)`, [id, orgId]));
  return id;
}

const reasonOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(Forbidden);
    return (error as Forbidden).reason;
  }
  throw new Error('預期丟 Forbidden，但通過了');
};

describe('authorize：物件（組織層，沒有案件）', () => {
  it.each(['admin', 'staff', 'viewer'] as const)('%s 讀取自己組織的物件成功', async (role) => {
    const id = await seedProperty(kit.orgA);
    const grant = await asRole_(kit.orgA, role, (tx) => authorize(tx, 'property.read', { type: 'property', id }));
    expect(grant).toEqual({ via: 'org_role', onBehalf: false });
  });

  it.each(['admin', 'staff'] as const)('%s 寫入物件成功', async (role) => {
    const id = await seedProperty(kit.orgA);
    await expect(asRole_(kit.orgA, role, (tx) => authorize(tx, 'property.manage', { type: 'property', id }))).resolves.toBeDefined();
  });

  it('viewer 寫入物件被拒，原因是 viewer_read_only', async () => {
    const id = await seedProperty(kit.orgA);
    const reason = await reasonOf(asRole_(kit.orgA, 'viewer', (tx) => authorize(tx, 'property.manage', { type: 'property', id })));
    expect(reason).toBe('viewer_read_only');
  });

  it('別的組織的物件與不存在的物件，原因相同（P0-02 AC1）', async () => {
    const other = await seedProperty(kit.orgB);
    const missing = newUlid();
    const crossOrg = await reasonOf(asRole_(kit.orgA, 'admin', (tx) => authorize(tx, 'property.read', { type: 'property', id: other })));
    const absent = await reasonOf(asRole_(kit.orgA, 'admin', (tx) => authorize(tx, 'property.read', { type: 'property', id: missing })));
    expect(crossOrg).toBe('object_not_found');
    expect(absent).toBe('object_not_found');
  });

  it('物件不存在時，viewer 寫入也回 object_not_found，不因角色洩漏差異', async () => {
    const reason = await reasonOf(
      asRole_(kit.orgA, 'viewer', (tx) => authorize(tx, 'property.manage', { type: 'property', id: newUlid() })),
    );
    expect(reason).toBe('object_not_found');
  });
});

describe('authorize：合約（案件表還沒有，依組織角色）', () => {
  it('viewer 讀合約成功，寫入類動作全部被拒', async () => {
    const id = await seedContract(kit.orgA);
    const contract: AuthObject = { type: 'contract', id };
    await expect(asRole_(kit.orgA, 'viewer', (tx) => authorize(tx, 'contract.read', contract))).resolves.toBeDefined();
    for (const action of [
      'contract.draft_send',
      'contract.void',
      'contract.copy',
      'contract.resend',
      'contract.sign_link',
      'contract.refetch_files',
      'contract.simulate_signing',
    ] as const) {
      expect(await reasonOf(asRole_(kit.orgA, 'viewer', (tx) => authorize(tx, action, contract))), action).toBe('viewer_read_only');
    }
  });

  it.each(['admin', 'staff'] as const)('%s 對合約的寫入類動作成功', async (role) => {
    const id = await seedContract(kit.orgA);
    for (const action of ['contract.draft_send', 'contract.void', 'contract.copy', 'contract.sign_link'] as const) {
      await expect(asRole_(kit.orgA, role, (tx) => authorize(tx, action, { type: 'contract', id }))).resolves.toBeDefined();
    }
  });

  it('建立合約（物件是組織本身）：staff 成功，viewer 被拒', async () => {
    await expect(asRole_(kit.orgA, 'staff', (tx) => authorize(tx, 'contract.draft_send', { type: 'org' }))).resolves.toBeDefined();
    expect(await reasonOf(asRole_(kit.orgA, 'viewer', (tx) => authorize(tx, 'contract.draft_send', { type: 'org' })))).toBe(
      'viewer_read_only',
    );
  });

  it('別的組織的合約與不存在的合約，原因相同', async () => {
    const other = await seedContract(kit.orgB);
    const a = await reasonOf(asRole_(kit.orgA, 'admin', (tx) => authorize(tx, 'contract.read', { type: 'contract', id: other })));
    const b = await reasonOf(asRole_(kit.orgA, 'admin', (tx) => authorize(tx, 'contract.read', { type: 'contract', id: newUlid() })));
    expect([a, b]).toEqual(['object_not_found', 'object_not_found']);
  });

  it('帳務、修繕這類一定要有案件的動作，沒有案件就拒絕，不因為是 admin 而放行', async () => {
    const id = await seedContract(kit.orgA);
    for (const action of ['ledger.record_payment', 'repair.manage', 'inspection.confirm', 'handover.initiate'] as const) {
      expect(await reasonOf(asRole_(kit.orgA, 'admin', (tx) => authorize(tx, action, { type: 'contract', id }))), action).toBe('no_case');
    }
  });
});

describe('authorize：組織層動作', () => {
  it('成員管理與稽核匯出只限 admin', async () => {
    for (const action of ['org_member.manage', 'audit.export'] as const) {
      await expect(asRole_(kit.orgA, 'admin', (tx) => authorize(tx, action, { type: 'org' }))).resolves.toBeDefined();
      expect(await reasonOf(asRole_(kit.orgA, 'staff', (tx) => authorize(tx, action, { type: 'org' }))), action).toBe('role_not_allowed');
      expect(await reasonOf(asRole_(kit.orgA, 'viewer', (tx) => authorize(tx, action, { type: 'org' }))), action).toBe(
        action === 'org_member.manage' ? 'viewer_read_only' : 'role_not_allowed',
      );
    }
  });

  it('成員列表所有角色都能讀', async () => {
    for (const role of ['admin', 'staff', 'viewer'] as const) {
      await expect(asRole_(kit.orgA, role, (tx) => authorize(tx, 'org_member.read', { type: 'org' }))).resolves.toBeDefined();
    }
  });

  it('沒有組織脈絡（承租人）對組織層動作回 no_org_context', async () => {
    const rc: RequestContext = { kind: 'party', userId: TEST_USER_ID, partyId: TEST_PARTY_ID, requestId: 'test' };
    const reason = await reasonOf(
      withTx({ kind: 'org', orgId: kit.orgA, partyId: TEST_PARTY_ID }, (tx) => {
        bindAccessContext(tx, rc);
        return authorize(tx, 'audit.export', { type: 'org' });
      }),
    );
    expect(reason).toBe('no_org_context');
  });
});

describe('checkAccess 與 authorize 的介面規則', () => {
  it('checkAccess 不丟錯，回傳決定與 Forbidden', async () => {
    const result = await asRole_(kit.orgA, 'viewer', (tx) => checkAccess(tx, 'property.manage', { type: 'property', id: newUlid() }));
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.forbidden.reason).toBe('object_not_found');
  });

  it('交易沒有綁定請求脈絡時丟程式錯誤，不得當成拒絕或放行', async () => {
    const error = await withTx({ kind: 'org', orgId: kit.orgA }, (tx) => authorize(tx, 'property.read', { type: 'org' })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(Forbidden);
  });

  it('Forbidden 的訊息不含原因碼，可以直接寫進日誌', async () => {
    const error = (await asRole_(kit.orgA, 'viewer', (tx) =>
      authorize(tx, 'property.manage', { type: 'org' }),
    ).catch((e: unknown) => e)) as Forbidden;
    expect(error.message).toBe('沒有權限執行此操作');
    expect(error.message).not.toContain('viewer');
    expect(error.reason).toBe('viewer_read_only');
  });
});

describe('authorizeAuditExport（稽核紀錄匯出，P0-23 AC6）', () => {
  it('只有 admin 通過', async () => {
    await expect(asRole_(kit.orgA, 'admin', (tx) => authorizeAuditExport(tx))).resolves.toEqual({ via: 'org_role', onBehalf: false });
    expect(await reasonOf(asRole_(kit.orgA, 'staff', (tx) => authorizeAuditExport(tx)))).toBe('role_not_allowed');
    expect(await reasonOf(asRole_(kit.orgA, 'viewer', (tx) => authorizeAuditExport(tx)))).toBe('role_not_allowed');
  });
});

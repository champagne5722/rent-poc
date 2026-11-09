import fs from 'node:fs';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATA_DIR } from '@/lib/db';
import { actAs, actAsContext, setupRouteDb, TEST_PARTY_ID, TEST_USER_ID, type RouteDb } from '@/lib/pg/route-test-kit';
import { newUlid } from '@/lib/pg/ulid';
import type { OrgRole } from '@/lib/request-context';
import { POST as advance } from './mock/advance/route';
import { GET as getEquipment, POST as addEquipment } from './equipment-vocabulary/route';
import { DELETE as deleteContract, GET as getContract, PUT as putContract } from './contracts/[id]/route';
import { GET as getAuditTrail } from './contracts/[id]/audit-trail/route';
import { POST as copyContract } from './contracts/[id]/copy/route';
import { GET as getEvents } from './contracts/[id]/events/route';
import { GET as getFiles, POST as refetchFiles } from './contracts/[id]/files/route';
import { GET as getPdf } from './contracts/[id]/pdf/route';
import { GET as getPractitioners, PUT as putPractitioners } from './contracts/[id]/practitioners/route';
import { POST as resend } from './contracts/[id]/resend/route';
import { POST as send } from './contracts/[id]/send/route';
import { GET as getSignLink } from './contracts/[id]/sign-link/route';
import { GET as getSignatureRecords } from './contracts/[id]/signature-records/route';
import { GET as getSignedPdf } from './contracts/[id]/signed-pdf/route';
import { POST as voidContract } from './contracts/[id]/void/route';
import { GET as listContracts, POST as createContract } from './contracts/route';
import { DELETE as deleteInvitation } from './org/invitations/[id]/route';
import { DELETE as removeMember, PATCH as patchMember } from './org/members/[userId]/route';
import { GET as listMembers, POST as inviteMember } from './org/members/route';
import { DELETE as deleteProperty, GET as getProperty, PUT as putProperty } from './properties/[id]/route';
import { GET as listProperties, POST as createProperty } from './properties/route';

// MIL-108：物件、合約、成員管理 route 都經 authorize()。
// 驗證三件事：viewer 讀取成功、viewer 寫入被拒、別的組織的資料與不存在的資料回應逐位元相同（P0-02 AC1）。
// 連線是 PGlite 的 app_rw，RLS 生效。簽署模組用 mock 模式。

vi.mock('@/lib/db', async (importOriginal) => {
  const os = await import('node:os');
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  return {
    ...(await importOriginal<typeof import('@/lib/db')>()),
    DATA_DIR: fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'access-route-')),
  };
});

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(async () => {
  await kit.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
beforeEach(async () => {
  await kit.reset();
  actAs(kit.orgA);
});

function actAsRole(orgId: string, role: OrgRole): void {
  actAsContext({ kind: 'org', orgId, orgKind: 'owner', userId: TEST_USER_ID, partyId: TEST_PARTY_ID, role, requestId: 'test' });
}

const json = (res: Response) => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const snap = async (res: Response) => ({ status: res.status, body: await res.text() });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, payload?: unknown) =>
  new NextRequest('http://localhost/api/x', { method, body: payload === undefined ? undefined : JSON.stringify(payload) });

const FORBIDDEN = { status: 403, body: JSON.stringify({ error: '沒有權限執行此操作' }) };
const CONTRACT_NOT_FOUND = { status: 404, body: JSON.stringify({ error: '合約不存在' }) };
const PROPERTY_NOT_FOUND = { status: 404, body: JSON.stringify({ error: '物件不存在' }) };

const PROPERTY_BODY = { name: '大安區溫馨兩房', address: '台北市大安區某路 1 號', default_rent: 20000, equipment: [] };

/** 以 admin 在 org 建一份物件與合約草稿。 */
async function seed(orgId: string): Promise<{ propertyId: string; contractId: string }> {
  actAsRole(orgId, 'admin');
  const property = await json(await createProperty(req('POST', PROPERTY_BODY)));
  const propertyId = property.data.id as string;
  const contract = await json(await createContract(req('POST', { property_id: propertyId })));
  return { propertyId, contractId: contract.data.id as string };
}

describe('viewer：讀取成功', () => {
  it('物件、設備詞彙庫、合約清單與詳情、歷程、簽署紀錄、指派選項、文件清單、PDF 預覽', async () => {
    const { propertyId, contractId } = await seed(kit.orgA);
    actAsRole(kit.orgA, 'viewer');

    expect((await listProperties()).status).toBe(200);
    expect((await getProperty(req('GET'), ctx(propertyId))).status).toBe(200);
    expect((await getEquipment()).status).toBe(200);
    expect((await listContracts()).status).toBe(200);
    expect((await getContract(req('GET'), ctx(contractId))).status).toBe(200);
    expect((await getEvents(req('GET'), ctx(contractId))).status).toBe(200);
    expect((await getSignatureRecords(req('GET'), ctx(contractId))).status).toBe(200);
    expect((await getFiles(req('GET'), ctx(contractId))).status).toBe(200);
    // 指派選項與 PDF 預覽依賴分流條件與登錄，狀態可能是 200 或 400，重點是沒被權限擋下
    expect([200, 400]).toContain((await getPractitioners(req('GET'), ctx(contractId))).status);
    expect([200, 400]).toContain((await getPdf(req('GET'), ctx(contractId))).status);
  });

  it('成員列表', async () => {
    // 待處理邀請只給 admin 看，由 listMembers 過濾，orgs.test.ts 已涵蓋
    actAsRole(kit.orgA, 'viewer');
    expect((await listMembers()).status).toBe(200);
  });
});

describe('viewer：寫入被拒（403，本文固定，不含原因碼）', () => {
  it('物件新增、修改、刪除，設備詞彙新增', async () => {
    const { propertyId } = await seed(kit.orgA);
    actAsRole(kit.orgA, 'viewer');

    expect(await snap(await createProperty(req('POST', PROPERTY_BODY)))).toEqual(FORBIDDEN);
    expect(await snap(await putProperty(req('PUT', PROPERTY_BODY), ctx(propertyId)))).toEqual(FORBIDDEN);
    expect(await snap(await deleteProperty(req('DELETE'), ctx(propertyId)))).toEqual(FORBIDDEN);
    expect(await snap(await addEquipment(req('POST', { name: '投影機' })))).toEqual(FORBIDDEN);

    actAsRole(kit.orgA, 'admin');
    expect((await json(await listProperties())).data).toHaveLength(1);
    expect((await json(await getProperty(req('GET'), ctx(propertyId)))).data.name).toBe(PROPERTY_BODY.name);
  });

  it('合約建立、修改、刪除、送簽、複製、指派、撤回、重寄、簽署連結、補抓文件、模擬簽署', async () => {
    const { propertyId, contractId } = await seed(kit.orgA);
    actAsRole(kit.orgA, 'viewer');

    const denied = [
      await createContract(req('POST', { property_id: propertyId })),
      await putContract(req('PUT', { fields: { landlordName: '改名' } }), ctx(contractId)),
      await deleteContract(req('DELETE'), ctx(contractId)),
      await send(req('POST'), ctx(contractId)),
      await copyContract(req('POST'), ctx(contractId)),
      await putPractitioners(req('PUT', { assignments: [] }), ctx(contractId)),
      await voidContract(req('POST'), ctx(contractId)),
      await resend(req('POST'), ctx(contractId)),
      await getSignLink(req('GET'), ctx(contractId)),
      await refetchFiles(req('POST'), ctx(contractId)),
      await advance(req('POST', { contract_id: contractId, event: 'signed' })),
    ];
    for (const res of denied) expect(await snap(res)).toEqual(FORBIDDEN);

    // 合約沒被動過：仍是草稿，欄位沒被改，沒有複製出新合約
    actAsRole(kit.orgA, 'admin');
    const after = await json(await getContract(req('GET'), ctx(contractId)));
    expect(after.data.status).toBe('draft');
    expect(after.data.fields.landlordName).not.toBe('改名');
    expect((await json(await listContracts())).data).toHaveLength(1);
  });

  it('成員邀請、改角色、移除、撤銷邀請', async () => {
    actAsRole(kit.orgA, 'viewer');
    const someone = newUlid();
    expect((await inviteMember(req('POST', { email: 'x@example.com', role: 'staff' }))).status).toBe(403);
    expect((await patchMember(req('PATCH', { role: 'staff' }) as never, { params: Promise.resolve({ userId: someone }) })).status).toBe(403);
    expect((await removeMember(req('DELETE') as never, { params: Promise.resolve({ userId: someone }) })).status).toBe(403);
    expect((await deleteInvitation(req('DELETE') as never, { params: Promise.resolve({ id: someone }) })).status).toBe(403);
  });
});

describe('staff：寫入成功', () => {
  it('修改物件與合約草稿、送簽前的複製與指派', async () => {
    const { propertyId, contractId } = await seed(kit.orgA);
    actAsRole(kit.orgA, 'staff');
    expect((await putProperty(req('PUT', { ...PROPERTY_BODY, note: '改過' }), ctx(propertyId))).status).toBe(200);
    expect((await putContract(req('PUT', { fields: { landlordName: '林房東' } }), ctx(contractId))).status).toBe(200);
    expect((await copyContract(req('POST'), ctx(contractId))).status).toBe(201);
  });

  it('staff 管理成員仍被拒（只有 admin）', async () => {
    actAsRole(kit.orgA, 'staff');
    expect((await inviteMember(req('POST', { email: 'x@example.com', role: 'staff' }))).status).toBe(403);
  });
});

describe('別的組織的資料與不存在的資料：回應逐位元相同（P0-02 AC1）', () => {
  // 每個以 ID 指到合約的 route。呼叫端換成別的組織的角色，看到的必須和不存在的 ID 一樣。
  const contractCalls: Array<[string, (id: string) => Promise<Response>]> = [
    ['GET 詳情', (id) => getContract(req('GET'), ctx(id))],
    ['PUT 修改', (id) => putContract(req('PUT', { fields: {} }), ctx(id))],
    ['DELETE 刪除', (id) => deleteContract(req('DELETE'), ctx(id))],
    ['POST 送簽', (id) => send(req('POST'), ctx(id))],
    ['POST 複製', (id) => copyContract(req('POST'), ctx(id))],
    ['GET 指派', (id) => getPractitioners(req('GET'), ctx(id))],
    ['PUT 指派', (id) => putPractitioners(req('PUT', { assignments: [] }), ctx(id))],
    ['POST 撤回', (id) => voidContract(req('POST'), ctx(id))],
    ['POST 重寄', (id) => resend(req('POST'), ctx(id))],
    ['GET 簽署連結', (id) => getSignLink(req('GET'), ctx(id))],
    ['GET 文件清單', (id) => getFiles(req('GET'), ctx(id))],
    ['POST 補抓文件', (id) => refetchFiles(req('POST'), ctx(id))],
    ['GET 歷程', (id) => getEvents(req('GET'), ctx(id))],
    ['GET 簽署紀錄', (id) => getSignatureRecords(req('GET'), ctx(id))],
    ['GET PDF 預覽', (id) => getPdf(req('GET'), ctx(id))],
    ['GET 已簽 PDF', (id) => getSignedPdf(req('GET'), ctx(id))],
    ['GET Audit Trail', (id) => getAuditTrail(req('GET'), ctx(id))],
    ['POST 模擬簽署', (id) => advance(req('POST', { contract_id: id, event: 'signed' }))],
  ];

  it.each(['admin', 'staff', 'viewer'] as const)('合約，呼叫端是 %s', async (role) => {
    const { contractId } = await seed(kit.orgA);
    actAsRole(kit.orgB, role);
    for (const [name, call] of contractCalls) {
      const other = await snap(await call(contractId));
      const missing = await snap(await call(newUlid()));
      expect(other, name).toEqual(CONTRACT_NOT_FOUND);
      expect(missing, name).toEqual(other);
    }
  });

  it.each(['admin', 'staff', 'viewer'] as const)('物件，呼叫端是 %s', async (role) => {
    const { propertyId } = await seed(kit.orgA);
    actAsRole(kit.orgB, role);
    const calls: Array<[string, (id: string) => Promise<Response>]> = [
      ['GET', (id) => getProperty(req('GET'), ctx(id))],
      ['PUT', (id) => putProperty(req('PUT', PROPERTY_BODY), ctx(id))],
      ['DELETE', (id) => deleteProperty(req('DELETE'), ctx(id))],
    ];
    for (const [name, call] of calls) {
      const other = await snap(await call(propertyId));
      expect(other, name).toEqual(PROPERTY_NOT_FOUND);
      expect(await snap(await call(newUlid())), name).toEqual(other);
    }
  });

  it('別的組織的資料沒被動過', async () => {
    const { propertyId, contractId } = await seed(kit.orgA);
    actAsRole(kit.orgB, 'admin');
    await putProperty(req('PUT', { ...PROPERTY_BODY, name: '被改' }), ctx(propertyId));
    await deleteContract(req('DELETE'), ctx(contractId));
    actAsRole(kit.orgA, 'admin');
    expect((await json(await getProperty(req('GET'), ctx(propertyId)))).data.name).toBe(PROPERTY_BODY.name);
    expect((await getContract(req('GET'), ctx(contractId))).status).toBe(200);
  });
});

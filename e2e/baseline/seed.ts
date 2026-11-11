import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { seedSendableDraft, seedVerifiedProperty, READY_FIELDS } from '../helpers/api';
import { STATUS_ANNEX_ITEMS, STATUS_ANNEX_VERSION } from '../../src/lib/status-annex/items';

// 現況基準（MIL-170）的測試資料。
// 資料每次都在全新的 PGlite 建立，全部走應用程式自己的 API。每一步獨立記錄成敗：
// 某一步失敗時，其他頁面照樣截圖，失敗原因寫進報告的「資料準備」一節。

export interface StepLog {
  step: string;
  ok: boolean;
  detail?: string;
}

export const stepLog: StepLog[] = [];

export async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const value = await fn();
    stepLog.push({ step: name, ok: true });
    return value;
  } catch (error) {
    stepLog.push({ step: name, ok: false, detail: error instanceof Error ? error.message.slice(0, 400) : String(error) });
    return undefined;
  }
}

async function ok(response: Awaited<ReturnType<APIRequestContext['get']>>, what: string): Promise<unknown> {
  if (!response.ok()) throw new Error(`${what}：${response.status()} ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

/** 1x1 的 PNG，當作證據檔與同意書。detectEvidenceType 認的是檔頭。 */
export const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

export const PDF_SAMPLE_PATH = path.join(__dirname, '..', '..', 'public');
export function readTinyPng(): Buffer {
  return TINY_PNG;
}
export function readIfExists(file: string): Buffer | null {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}

export interface OwnerWorld {
  propertyIds: string[];
  /** 簽署中（待乙方簽） */
  signingContractId: string;
  /** 已完成，案件有帳務設定 */
  completedContractId: string;
  completedCaseId: string | null;
  /** 草稿，欄位齊全 */
  readyDraftId: string;
  /** 草稿，只有物件 */
  bareDraftId: string;
  /** 已拒簽 */
  declinedContractId: string;
}

async function advance(page: Page, contractId: string, event: string): Promise<void> {
  await ok(await page.request.post('/api/mock/advance', { data: { contract_id: contractId, event } }), `模擬簽署事件 ${event}`);
}

export async function seedOwner(page: Page, browser: Browser): Promise<Partial<OwnerWorld>> {
  const world: Partial<OwnerWorld> = {};
  const properties = [
    await step('物件甲', () => seedVerifiedProperty(page, browser, '大安和平東路 3 樓', '台北市大安區和平東路二段 100 號 3 樓')),
    await step('物件乙', () => seedVerifiedProperty(page, browser, '板橋文化路 5 樓', '新北市板橋區文化路一段 200 號 5 樓')),
    await step('物件丙', () => seedVerifiedProperty(page, browser, '信義松仁路 12 樓', '台北市信義區松仁路 88 號 12 樓')),
    await step('物件丁', () => seedVerifiedProperty(page, browser, '中和景平路 2 樓', '新北市中和區景平路 300 號 2 樓')),
  ].filter((p): p is NonNullable<typeof p> => Boolean(p));
  world.propertyIds = properties.map((p) => p.id);
  const [a, b, c, d] = properties;
  if (!a || !b || !c || !d) return world;

  // 簽署中：送簽後停在待乙方簽
  world.signingContractId = await step('合約：簽署中', async () => {
    const id = await seedSendableDraft(page, a.id);
    await ok(await page.request.post(`/api/contracts/${id}/send`), '送簽');
    return id;
  });
  // 已完成：乙方簽署，再甲方簽署完成。完成時系統建押金台帳與應收期別
  world.completedContractId = await step('合約：已完成', async () => {
    const id = await seedSendableDraft(page, b.id);
    await ok(await page.request.post(`/api/contracts/${id}/send`), '送簽');
    await advance(page, id, 'signed');
    await advance(page, id, 'completed');
    return id;
  });
  world.declinedContractId = await step('合約：已拒簽', async () => {
    const id = await seedSendableDraft(page, c.id);
    await ok(await page.request.post(`/api/contracts/${id}/send`), '送簽');
    await advance(page, id, 'declined');
    return id;
  });
  world.readyDraftId = await step('合約：草稿（欄位齊全）', () => seedSendableDraft(page, c.id));
  world.bareDraftId = await step('合約：草稿（只有物件）', async () => {
    const response = await page.request.post('/api/contracts', { data: { property_id: d.id } });
    return ((await ok(response, '建立草稿')) as { data: { id: string } }).data.id;
  });

  // 案件：合約掛在自管案件下。已完成合約的案件有帳務設定
  await step('案件：已完成合約的案件', async () => {
    const body = (await ok(await page.request.get('/api/cases'), '案件清單')) as { data: Array<{ id: string; title: string; contractStatus: string | null }> };
    const done = body.data.find((c) => c.contractStatus === 'completed') ?? body.data.find((c) => c.title.includes('板橋'));
    world.completedCaseId = done?.id ?? null;
    if (!world.completedCaseId) throw new Error(`找不到已完成合約的案件：${JSON.stringify(body.data.map((c) => [c.title, c.contractStatus])).slice(0, 300)}`);
  });

  await step('收款帳戶', async () => {
    await ok(
      await page.request.post('/api/payment-accounts', {
        data: { name: '房東主帳戶', method: 'bank', holderKind: 'lessor', holderName: READY_FIELDS.landlordName, bankCode: '004', accountLast4: '5678' },
      }),
      '登錄收款帳戶',
    );
  });

  await step('成員邀請', async () => {
    await ok(await page.request.post('/api/org/members', { data: { email: 'e2e-staff@example.com', role: 'staff' } }), '邀請成員');
  });
  return world;
}

// ---------------------------------------------------------------------------
// 執業主體、審核台、承租人、包租合約

export interface PracticeWorld {
  deskLicenseItemId: string | null;
  deskCredentialItemId: string | null;
  masterLeaseContractId: string | null;
  masterLeaseDraftId: string | null;
}

interface QueueItem {
  id: string;
  type: string;
  status: string;
  summary?: { entityName?: string; taxId?: string; partyName?: string };
}

export async function deskQueue(operator: Page, status: 'open' | 'resolved' = 'open'): Promise<QueueItem[]> {
  const body = (await ok(await operator.request.get(`/api/desk/queue?status=${status}`), '審核台佇列')) as { data: { items: QueueItem[] } };
  return body.data.items;
}

function png(name: string) {
  return { name, mimeType: 'image/png', buffer: TINY_PNG };
}

export async function submitLicense(page: Page, kind: string, permitNo: string): Promise<void> {
  const response = await page.request.post('/api/practice/licenses', { multipart: { kind, permitNo, files: png('permit.png') } });
  await ok(response, `送件 ${kind}`);
}

export async function checkItem(operator: Page, itemId: string, kind: 'license' | 'credential', extra: Record<string, unknown> = {}): Promise<void> {
  const url = kind === 'license' ? `/api/desk/items/${itemId}/check` : `/api/desk/items/${itemId}/credential-check`;
  const data =
    kind === 'license'
      ? { channel: 'document_review', querySource: '商工登記公示資料', result: 'match', note: '', businessItemCodes: ['H706011', 'H706021', 'H704031'], registrationStatus: '核准設立', ...extra }
      : { channel: 'resim_manual', querySource: 'resim 證書查詢', result: 'match', note: '', validUntil: '2030-06-30', ...extra };
  await ok(await operator.request.post(url, { data }), `核對 ${itemId}`);
}

/**
 * 執業主體甲：兩個業別、證書、任職都核對相符，包租合約的執業人員候選就是這位。
 * 執業主體乙：業別核對相符，登錄證書與任職但留在待驗證（審核台有證書核對與任職核對的未結項目）。
 * 執業主體丙：只送件，業別留在待驗證（審核台有業別核對的未結項目；也用來看「還沒同意個資告知」的畫面）。
 * 回傳審核台上兩個未結項目的 ID（業別核對、證書核對）。
 */
export async function seedPracticeAndDesk(practice: Page, practice2: Page, practice3: Page, operator: Page): Promise<Pick<PracticeWorld, 'deskLicenseItemId' | 'deskCredentialItemId'>> {
  await step('執業主體甲：送件', async () => {
    await submitLicense(practice, 'management', '北市租管字第 0001 號');
    await submitLicense(practice, 'master_lease', '北市租包字第 0001 號');
  });
  await step('執業主體乙：送件', () => submitLicense(practice2, 'brokerage', '北市經紀字第 0002 號'));
  await step('執業主體丙：送件', () => submitLicense(practice3, 'brokerage', '北市經紀字第 0003 號'));
  await step('營運者：核對執業主體甲、乙的業別', async () => {
    const items = await deskQueue(operator);
    const targets = items.filter((i) => i.type === 'license' && (i.summary?.taxId === '24680135' || i.summary?.taxId === '13572468'));
    if (targets.length === 0) throw new Error(`佇列裡找不到業別項目：${JSON.stringify(items).slice(0, 300)}`);
    for (const item of targets) await checkItem(operator, item.id, 'license');
  });
  await step('執業人員甲：同意個資告知並登錄證書', async () => {
    await ok(await practice.request.post('/api/practitioner/consent', { data: { decision: 'agree' } }), '同意個資告知');
    await ok(await practice.request.post('/api/practitioner/certificates', { multipart: certForm('rental_housing_manager', '北市租管', '00123') }), '登錄證書');
  });
  await step('執業人員乙：同意個資告知並登錄證書', async () => {
    await ok(await practice2.request.post('/api/practitioner/consent', { data: { decision: 'agree' } }), '同意個資告知');
    await ok(await practice2.request.post('/api/practitioner/certificates', { multipart: certForm('real_estate_broker', '北市經紀', '00456') }), '登錄證書');
  });
  await step('營運者：核對執業人員甲的證書與任職', async () => {
    // 佇列的 summary.partyName 是登錄人的名稱（email 的前半段）。證書核對後，任職項目才能核對，所以分兩輪
    for (const type of ['certificate', 'employment']) {
      const items = await deskQueue(operator);
      const mine = items.filter((i) => i.type === type && i.summary?.partyName === 'e2e-practice');
      stepLog.push({ step: `審核台 ${type} 項目（除錯）`, ok: true, detail: JSON.stringify(items.filter((i) => i.type === type).map((i) => i.summary)).slice(0, 300) });
      for (const item of mine) await checkItem(operator, item.id, 'credential');
    }
  });
  const open = (await step('營運者：讀未結佇列', () => deskQueue(operator))) ?? [];
  stepLog.push({ step: '審核台未結項目（除錯）', ok: true, detail: open.map((i) => `${i.type}:${i.status}`).join(', ') });
  return {
    deskLicenseItemId: open.find((i) => i.type === 'license')?.id ?? null,
    deskCredentialItemId: open.find((i) => i.type === 'certificate')?.id ?? open.find((i) => i.type === 'employment')?.id ?? null,
  };
}

function certForm(kind: string, word: string, serial: string) {
  return {
    certificateKind: kind,
    certYear: '112',
    certWord: word,
    certSerial: serial,
    issuedOn: '2026-06-30',
    validUntil: '2030-06-30',
    startedOn: '2026-07-01',
    files: png('cert.png'),
  };
}

/**
 * 委託管理合約的草稿，欄位、委託標的清單與簽署區都備齊（MIL-185 的最終截圖用）。
 * 委託管理合約不綁單一物件，標的清單由物件挑。精靈開啟時落在最後一步。
 */
export async function seedManagementDraft(page: Page, propertyIds: string[]): Promise<string> {
  const created = (await ok(await page.request.post('/api/contracts', { data: { contract_type: 'management' } }), '建立委託管理草稿')) as { data: { id: string } };
  const id = created.data.id;
  await ok(
    await page.request.put(`/api/contracts/${id}`, {
      data: {
        fields: {
          mandatorName: READY_FIELDS.landlordName,
          mandatorEmail: READY_FIELDS.landlordEmail,
          mandataryName: '北辰示範租賃股份有限公司',
          mandataryEmail: 'e2e-practice@example.com',
          termStart: '2026-09-01',
          termEnd: '2027-08-31',
          feeMode: 'rent_percentage',
          feeValue: 5,
        },
        signature_fields: [
          { id: 'm1', signer: 'party_a', page: 0, x: 0.6, y: 0.8, w: 0.2, h: 0.1 },
          { id: 'm2', signer: 'party_b', page: 0, x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
        ],
      },
    }),
    '補委託管理欄位',
  );
  await ok(
    await page.request.put(`/api/contracts/${id}/mandate-items`, {
      data: { items: propertyIds.slice(0, 2).map((propertyId) => ({ propertyId, scopes: ['rent_collection', 'repair'] })) },
    }),
    '委託標的清單',
  );
  return id;
}

/** 包租租賃合約：執業主體建立，人選來自 seed 假資料 adapter。 */
export async function seedMasterLease(practice: Page, browser: Browser): Promise<Pick<PracticeWorld, 'masterLeaseContractId' | 'masterLeaseDraftId'>> {
  const created = await step('包租：物件', () => seedVerifiedProperty(practice, browser, '包租示範物件', '台北市中山區南京東路二段 50 號 6 樓'));
  if (!created) return { masterLeaseContractId: null, masterLeaseDraftId: null };

  const build = async (label: string, send: boolean): Promise<string | null> => {
    const id = await step(`包租：${label}建立`, async () => {
      const response = await practice.request.post('/api/contracts', {
        data: { property_id: created.id, routing: { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: false } },
      });
      return ((await ok(response, '建立包租草稿')) as { data: { id: string } }).data.id;
    });
    if (!id) return null;
    await step(`包租：${label}補欄位與簽署區`, async () => {
      // 現況確認附件：每一項填「正常」。附件內容隨草稿保存在 fields.statusAnnex
      const filledAnnex = { version: STATUS_ANNEX_VERSION, rows: STATUS_ANNEX_ITEMS.map((item) => ({ id: item.id, label: item.label, status: 'normal', note: '' })) };
      const options = (await ok(await practice.request.get(`/api/contracts/${id}/practitioners`), '指派選項')) as {
        data: { options: { seats?: Array<Record<string, unknown>> } };
      };
      type Entity = { id: string; practitioners?: Array<{ id: string }>; partySigners?: Array<{ id: string; name: string; email: string }> };
      const seats = options.data.options.seats ?? [];
      const seat = seats[0];
      const entity = ((seat?.entities ?? []) as Entity[]).find((e) => (e.practitioners?.length ?? 0) > 0);
      if (!seat || !entity?.practitioners?.[0] || !entity.partySigners?.[0]) throw new Error(`沒有可指派的執業人員：${JSON.stringify(seats).slice(0, 300)}`);
      const partySigner = entity.partySigners[0];
      // 甲方的姓名與 email 必須與所選的當事人簽署人相同
      await ok(
        await practice.request.put(`/api/contracts/${id}`, {
          data: { fields: { ...READY_FIELDS, landlordName: partySigner.name, landlordEmail: partySigner.email, statusAnnex: filledAnnex } },
        }),
        '補欄位',
      );
      const slot = seat.ruleId as string;
      await ok(
        await practice.request.put(`/api/contracts/${id}/practitioners`, {
          data: { assignments: [{ slot, entityId: entity.id, practitionerId: entity.practitioners[0].id, partySignerId: partySigner.id }] },
        }),
        '指派執業人員',
      );
      // 現況確認附件是 PDF 的最後一頁，執業人員必須在那一頁有簽署區域
      let pageCount = 3;
      const pdf = await practice.request.get(`/api/contracts/${id}/pdf`);
      if (pdf.ok()) pageCount = (await PDFDocument.load(await pdf.body())).getPageCount();
      stepLog.push({ step: `包租：${label} PDF 頁數（除錯）`, ok: true, detail: String(pageCount) });
      const signature_fields = [
        { id: 's0', signer: 'party_a', slot: 'lease.master_lease.party_a', page: 0, x: 0.55, y: 0.8, w: 0.2, h: 0.08 },
        { id: 's1', signer: 'party_b', slot: 'lease.master_lease.party_b', page: 0, x: 0.1, y: 0.8, w: 0.2, h: 0.08 },
        { id: 's2', signer: 'practitioner', slot, page: 0, x: 0.1, y: 0.9, w: 0.2, h: 0.06 },
        { id: 's3', signer: 'practitioner', slot, page: pageCount - 1, x: 0.1, y: 0.8, w: 0.2, h: 0.08 },
      ];
      await ok(await practice.request.put(`/api/contracts/${id}`, { data: { signature_fields } }), '補簽署區');
    });
    if (send) {
      await step(`包租：${label}送簽`, async () => {
        const response = await practice.request.post(`/api/contracts/${id}/send`);
        await ok(response, '送簽');
      });
    }
    return id;
  };
  const sent = await build('簽署中', true);
  const draft = await build('草稿', false);
  return { masterLeaseContractId: sent, masterLeaseDraftId: draft };
}

import { expect, type Browser, type Page } from '@playwright/test';
import { newUserContext, signIn } from '../baseline/session';

// 測試資料的準備。這些只是「前置條件」，被測的行為一律走畫面。
// 資料每次執行都重新建立，名稱帶隨機尾碼，不依賴既有資料，也不依賴測試的執行順序。
// 用 page.request：與瀏覽器共用登入 cookie，等於同一位使用者呼叫應用程式自己的 API。

/** 隨機尾碼，讓同一次執行內的資料名稱互不相同。 */
export function uniqueSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

export interface SeededProperty {
  id: string;
  name: string;
  address: string;
  /** 登錄時用的建號（不含分號）。審核台的列用「建號 N-000」找這個物件的項目。 */
  buildingNo: string;
}

/** 登錄物件時建號必填（ADR-0028 決議 9）。隨機建號，同一個組織重複用同一個鍵會得到既有的那一筆。 */
export function uniqueBuildingNo(): string {
  return String(10_000 + Math.floor(Math.random() * 89_999));
}

export async function seedProperty(page: Page, name: string, address = '台北市大安區和平東路二段 100 號 3 樓'): Promise<SeededProperty> {
  const buildingNo = uniqueBuildingNo();
  const response = await page.request.post('/api/properties', {
    data: {
      name,
      address,
      default_rent: 20000,
      equipment: [],
      anchor: { key: { city: 'A', town: '02', section: '0021', buildingNo, subNo: '' } },
    },
  });
  if (!response.ok()) throw new Error(`建立物件失敗：${response.status()} ${await response.text()}`);
  const body = (await response.json()) as { data: { id: string } };
  return { id: body.data.id, name, address, buildingNo };
}

// 物件通過平台的文件核對後才能建立合約與送簽（ADR-0028 決議 5，MIL-205）。
// 前置條件走既有的 API：物件的使用者同意個資告知、上傳謄本，平台營運者在審核台判定通過。
// 營運者的登入要 PLATFORM_OPERATOR_EMAILS，外殼 scripts/e2e/run-e2e.sh 替 flows、visual 與 baseline 設定。

const OPERATOR_EMAIL = process.env.BASELINE_OPERATOR_EMAIL ?? 'e2e-operator@example.com';

/** 最小的 PDF 檔頭。伺服器端以內容判斷類型，只認開頭的 %PDF。 */
const TRANSCRIPT = { name: '第二類謄本.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%E2E 測試用謄本\n') };

/** 每個瀏覽器只登入營運者一次。測試內的資料準備共用這個營運者頁面。 */
const operatorPages = new WeakMap<Browser, Promise<Page>>();

function operatorPageOf(browser: Browser): Promise<Page> {
  let pending = operatorPages.get(browser);
  if (!pending) {
    pending = (async () => {
      const context = await newUserContext(browser);
      const page = await context.newPage();
      await signIn(page, OPERATOR_EMAIL);
      return page;
    })();
    operatorPages.set(browser, pending);
  }
  return pending;
}

async function okJson<T>(response: Awaited<ReturnType<Page['request']['get']>>, what: string): Promise<T> {
  if (!response.ok()) throw new Error(`${what}：${response.status()} ${(await response.text()).slice(0, 300)}`);
  return (await response.json()) as T;
}

/**
 * 讓已登錄的物件通過文件核對：同意個資告知、上傳謄本、營運者判定通過。
 * `page` 是物件所屬組織的成員。`submitOnly` 為 true 時只送出謄本，物件停在待核對（測核對畫面用）。
 */
export async function verifyPropertyViaApi(page: Page, browser: Browser, property: SeededProperty, options: { submitOnly?: boolean } = {}): Promise<void> {
  const consent = await page.request.post(`/api/properties/${property.id}/ownership/consent`, { data: { decision: 'agree' } });
  if (!consent.ok()) throw new Error(`同意個資告知失敗：${consent.status()} ${await consent.text()}`);
  const upload = await page.request.post(`/api/properties/${property.id}/ownership`, {
    multipart: { claimed_owner: '王大明', acquired_at: '2026-01-15', file: TRANSCRIPT },
  });
  if (upload.status() !== 201) throw new Error(`上傳謄本失敗：${upload.status()} ${await upload.text()}`);
  if (options.submitOnly) return;

  const operator = await operatorPageOf(browser);
  const queue = await okJson<{ data: { items: Array<{ id: string; type: string; summary: { claimedKey?: { buildingNo: string } } }> } }>(
    await operator.request.get('/api/desk/queue?status=open'),
    '讀審核台佇列',
  );
  const item = queue.data.items.find(
    (i) => i.type === 'leasing_authority' && new RegExp(`^0*${property.buildingNo}$`).test(i.summary.claimedKey?.buildingNo ?? ''),
  );
  if (!item) throw new Error(`審核台找不到建號 ${property.buildingNo} 的出租權源項目`);
  const decision = await okJson<{ data: { outcome: string } }>(
    await operator.request.post(`/api/desk/ownership/${item.id}/decision`, {
      data: { key_match: true, holder_match: true, holder_masked: '王○明', reason: 'E2E 資料準備，文件相符' },
    }),
    '營運者判定',
  );
  expect(decision.data.outcome).toBe('verified');
  // 核對通過會通知物件的使用者。資料準備不該留下未讀通知：側欄的未讀數會進截圖基準
  const read = await page.request.post('/api/notifications/read-all');
  if (!read.ok()) throw new Error(`標示通知已讀失敗：${read.status()} ${await read.text()}`);
}

/** 登錄物件並讓它通過核對。建立合約與送簽的流程用這個。 */
export async function seedVerifiedProperty(
  page: Page,
  browser: Browser,
  name: string,
  address = '台北市大安區和平東路二段 100 號 3 樓',
): Promise<SeededProperty> {
  const property = await seedProperty(page, name, address);
  await verifyPropertyViaApi(page, browser, property);
  return property;
}

export const READY_FIELDS = {
  landlordName: '林房東',
  landlordEmail: 'landlord@example.com',
  tenantName: '王租客',
  tenantEmail: 'tenant@example.com',
  startDate: '2026-09-01',
  endDate: '2027-08-31',
};

const SIGNATURE_FIELDS = [
  { id: 'f1', signer: 'party_a', page: 0, x: 0.6, y: 0.8, w: 0.2, h: 0.1 },
  { id: 'f2', signer: 'party_b', page: 0, x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
];

/** 建立一份草稿，只帶物件，其餘欄位維持預設。 */
export async function seedDraft(page: Page, propertyId: string): Promise<string> {
  const response = await page.request.post('/api/contracts', { data: { property_id: propertyId } });
  if (!response.ok()) throw new Error(`建立合約草稿失敗：${response.status()} ${await response.text()}`);
  return ((await response.json()) as { data: { id: string } }).data.id;
}

/**
 * 建立一份欄位齊全、簽名框設好的草稿。簽名框要在 PDF 上拖曳放置，測試不重複走那一步，
 * 所以直接用 API 備好。送簽這個動作本身仍然走畫面。
 */
export async function seedSendableDraft(page: Page, propertyId: string): Promise<string> {
  const id = await seedDraft(page, propertyId);
  const response = await page.request.put(`/api/contracts/${id}`, {
    data: { fields: READY_FIELDS, signature_fields: SIGNATURE_FIELDS },
  });
  if (!response.ok()) throw new Error(`補齊草稿欄位失敗：${response.status()} ${await response.text()}`);
  return id;
}

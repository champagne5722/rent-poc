import type { Page } from '@playwright/test';

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

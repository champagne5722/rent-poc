import { describe, expect, it } from 'vitest';
import type { MandateRequestStatus, OwnerMandateRequest, PracticeMandateRequest, PropertyGroup } from '../types';
import { STORED_STATUSES } from './status';
import {
  draftBuildingText,
  draftSummaryText,
  kindOptions,
  licenseKindTitles,
  ownerCanSubmit,
  ownerCanWithdraw,
  ownerMustConfirmDraft,
  ownerNextStep,
  practiceNextStep,
  requestKindsFor,
  requestLinkUrl,
  unitOptions,
} from './view';

const ALL_STATUSES: MandateRequestStatus[] = [...STORED_STATUSES, 'expired'];

const practiceRequest = (status: MandateRequestStatus, extra: Partial<PracticeMandateRequest> = {}): PracticeMandateRequest => ({
  id: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: 'management',
  kind_label: '委託管理申請',
  status,
  created_at: '2026-11-10T02:00:00.000Z',
  deadline: '2026-11-17T02:00:00.000Z',
  submitted_at: null,
  withdrawn_at: null,
  draft: null,
  transcript_file_name: null,
  unit_count: null,
  ...extra,
});

const ownerRequest = (status: MandateRequestStatus, extra: Partial<OwnerMandateRequest> = {}): OwnerMandateRequest => ({
  id: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: 'management',
  kind_label: '委託管理申請',
  status,
  created_at: '2026-11-10T02:00:00.000Z',
  deadline: null,
  submitted_at: null,
  withdrawn_at: null,
  practice: { name: '北辰租賃', tax_id: '24680135', verified_kinds: ['management'] },
  draft: null,
  has_transcript: false,
  confirmed_unit_id: null,
  unit_ids: [],
  consent_notice: null,
  ...extra,
});

describe('申請種類與業別', () => {
  it('委託管理申請對代管業，住宅包租申請對包租業', () => {
    expect(requestKindsFor(['management'])).toEqual(['management']);
    expect(requestKindsFor(['master_lease'])).toEqual(['master_lease']);
    expect(requestKindsFor(['master_lease', 'management'])).toEqual(['management', 'master_lease']);
  });

  it('只有經紀業或沒有已驗證業別時，沒有可產生的種類', () => {
    expect(requestKindsFor(['brokerage'])).toEqual([]);
    expect(requestKindsFor([])).toEqual([]);
  });

  it('選項用法定名稱', () => {
    expect(kindOptions(['management', 'master_lease']).map((o) => o.label)).toEqual(['委託管理申請', '住宅包租申請']);
  });

  it('業別用法定稱謂，不認得的代碼原樣顯示', () => {
    expect(licenseKindTitles(['management', 'master_lease', 'brokerage', 'other'])).toEqual([
      '租賃住宅代管業者',
      '租賃住宅包租業者',
      '不動產經紀業者',
      'other',
    ]);
  });
});

describe('連結網址', () => {
  it('接上 origin，不重複斜線', () => {
    expect(requestLinkUrl('https://rent.example.com', '/request/abc')).toBe('https://rent.example.com/request/abc');
    expect(requestLinkUrl('https://rent.example.com/', '/request/abc')).toBe('https://rent.example.com/request/abc');
  });
});

describe('代填資料的摘要', () => {
  it('沒有代填資料寫「未代填」', () => {
    expect(draftSummaryText(null)).toBe('未代填');
    expect(draftSummaryText(null, '—')).toBe('—');
  });

  it('寫名稱與地址', () => {
    expect(draftSummaryText({ name: '大安兩房', address: '台北市大安區和平東路二段 100 號' })).toBe('大安兩房，台北市大安區和平東路二段 100 號');
  });

  it('建號帶分號時一起顯示', () => {
    const base = { name: 'a', address: 'b' };
    expect(draftBuildingText({ ...base, anchor: { key: { city: 'A', town: '02', section: '0021', buildingNo: '12345', subNo: '000' } } })).toBe('建號 12345-000');
    expect(draftBuildingText({ ...base, anchor: { key: { city: 'A', town: '02', section: '0021', buildingNo: '12345' } } })).toBe('建號 12345');
    expect(draftBuildingText({ ...base })).toBeNull();
    expect(draftBuildingText(null)).toBeNull();
  });
});

describe('業者的下一步：不暗示連結有沒有被打開', () => {
  it('每個狀態都有下一步', () => {
    for (const status of ALL_STATUSES) {
      const step = practiceNextStep(practiceRequest(status, { unit_count: 2 }));
      expect(step.headline.length).toBeGreaterThan(0);
      expect(step.owner.length).toBeGreaterThan(0);
    }
  });

  it('待屋主確認：文字只依狀態與期限，沒有任何「已打開」「已綁定」「已登入」的字樣', () => {
    const step = practiceNextStep(practiceRequest('pending_owner'));
    const text = `${step.headline}${step.owner}${step.detail ?? ''}`;
    expect(text).not.toMatch(/打開|開啟|綁定|登入|瀏覽|點擊|查看/);
    expect(step.detail).toBe('連結有效到 2026/11/17 10:00。');
  });

  it('屋主送出後顯示租賃單位的數量', () => {
    expect(practiceNextStep(practiceRequest('pending_practice', { unit_count: 3 })).detail).toBe('申請含 3 個租賃單位。');
  });
});

describe('屋主的下一步與按鈕', () => {
  it('每個狀態都有下一步', () => {
    for (const status of ALL_STATUSES) {
      const step = ownerNextStep(ownerRequest(status));
      expect(step.headline.length).toBeGreaterThan(0);
    }
  });

  it('只有待屋主確認能送出', () => {
    expect(ALL_STATUSES.filter((s) => ownerCanSubmit({ status: s }))).toEqual(['pending_owner']);
  });

  it('只有待業者接受能收回，還沒送出的申請沒有收回', () => {
    expect(ALL_STATUSES.filter((s) => ownerCanWithdraw({ status: s }))).toEqual(['pending_practice']);
    expect(ownerCanWithdraw({ status: 'pending_owner' })).toBe(false);
  });

  it('有代填資料而且還沒確認時，屋主要先確認', () => {
    const draft = { name: 'a', address: 'b' };
    expect(ownerMustConfirmDraft({ status: 'pending_owner', draft, confirmed_unit_id: null })).toBe(true);
    expect(ownerMustConfirmDraft({ status: 'pending_owner', draft, confirmed_unit_id: 'U1' })).toBe(false);
    expect(ownerMustConfirmDraft({ status: 'pending_owner', draft: null, confirmed_unit_id: null })).toBe(false);
    expect(ownerMustConfirmDraft({ status: 'expired', draft, confirmed_unit_id: null })).toBe(false);
  });
});

describe('屋主能選的租賃單位', () => {
  const unit = (id: string, extra: Record<string, unknown> = {}, unitExtra: Record<string, unknown> = {}) =>
    ({
      id: `P-${id}`,
      rental_unit_id: id,
      name: `物件 ${id}`,
      archived_at: null,
      unit: { suffix: '0000', label: null, floor: null, unit_type: 'whole', status: 'active', display_code: 'F18-7K3QZP', ...unitExtra },
      ...extra,
    }) as unknown as PropertyGroup['units'][number];

  it('列出沒封存、使用中的租賃單位，帶地址與顯示編碼', () => {
    const groups = [
      {
        id: 'G1',
        address: '台北市大安區和平東路二段 100 號',
        units: [
          unit('U1'),
          unit('U2', {}, { unit_type: 'sublet', suffix: '0001', label: '301' }),
          unit('U3', { archived_at: '2026-01-01T00:00:00Z' }),
          unit('U4', {}, { status: 'merged' }),
          unit('U5', { unit: null }),
        ],
      },
    ] as unknown as PropertyGroup[];
    expect(unitOptions(groups)).toEqual([
      { unitId: 'U1', name: '物件 U1', kindText: '整戶', address: '台北市大安區和平東路二段 100 號', displayCode: 'F18-7K3QZP' },
      { unitId: 'U2', name: '物件 U2', kindText: '分租 301', address: '台北市大安區和平東路二段 100 號', displayCode: 'F18-7K3QZP' },
    ]);
  });

  it('沒有物件時回空陣列', () => {
    expect(unitOptions([])).toEqual([]);
  });
});

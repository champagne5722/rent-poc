import { describe, expect, it } from 'vitest';
import type { MandateRequestStatus, OwnerMandateRequest, PracticeMandateRequest, PropertyGroup } from '../types';
import { STORED_STATUSES } from './status';
import {
  canEndRequest,
  decisionErrorReloads,
  decisionErrorText,
  draftBuildingNo,
  draftSummaryText,
  formatMonthDay,
  kindOptions,
  licenseKindTitles,
  ownerCanSubmit,
  ownerCanWithdraw,
  ownerClosedByText,
  ownerMustConfirmDraft,
  ownerNextStep,
  practiceCanRespond,
  practiceClosedByText,
  practiceDeadlineText,
  practiceMayShowUnits,
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
  accepted_at: null,
  manager_employment_id: null,
  closed_at: null,
  closed_by: null,
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
  accepted_at: null,
  closed_at: null,
  closed_by: null,
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
    expect(draftBuildingNo({ ...base, anchor: { key: { city: 'A', town: '02', section: '0021', buildingNo: '12345', subNo: '000' } } })).toBe('12345-000');
    expect(draftBuildingNo({ ...base, anchor: { key: { city: 'A', town: '02', section: '0021', buildingNo: '12345' } } })).toBe('12345');
    expect(draftBuildingNo({ ...base })).toBeNull();
    expect(draftBuildingNo(null)).toBeNull();
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

  it('屋主送出後顯示租賃單位的數量與回覆的期限', () => {
    const step = practiceNextStep(practiceRequest('pending_practice', { unit_count: 3 }));
    expect(step.detail).toBe('申請含 3 個租賃單位。請在 11月17日前回覆，逾期申請失效。');
  });

  it('已接受：寫「下一步是擬定契約」與送出合約的期限，不放任何物件的資料', () => {
    const step = practiceNextStep(practiceRequest('accepted', { deadline: '2026-12-10T02:00:00.000Z', unit_count: 3, accepted_at: '2026-11-10T02:00:00.000Z' }));
    expect(step.headline).toBe('申請已接受');
    expect(step.detail).toBe('下一步是擬定契約。請在 12月10日前送出合約，逾期申請失效。');
    expect(`${step.headline}${step.detail}`).not.toMatch(/租賃單位|物件|地址/);
  });

  it('已結束：寫是哪一方結束的', () => {
    expect(practiceNextStep(practiceRequest('ended', { closed_by: 'owner' })).headline).toBe('屋主已結束申請，不需要處理');
    expect(practiceNextStep(practiceRequest('ended', { closed_by: 'practice' })).headline).toBe('你的組織已結束申請，不需要處理');
    expect(practiceClosedByText({ status: 'declined', closed_by: 'practice' })).toBeNull();
  });
});

describe('業者的期限與租賃單位的顯示', () => {
  it('月日用臺北時間，月日不補零', () => {
    expect(formatMonthDay('2026-11-17T02:00:00.000Z')).toBe('11月17日');
    expect(formatMonthDay('2026-03-05T20:00:00.000Z')).toBe('3月6日');
    expect(formatMonthDay(null)).toBe('—');
    expect(formatMonthDay('不是日期')).toBe('—');
  });

  it('待業者接受寫幾月幾日前回覆，已接受寫幾月幾日前送出合約', () => {
    expect(practiceDeadlineText({ status: 'pending_practice', deadline: '2026-11-17T02:00:00.000Z' })).toBe('11月17日前回覆');
    expect(practiceDeadlineText({ status: 'accepted', deadline: '2026-12-10T02:00:00.000Z' })).toBe('12月10日前送出合約');
  });

  it('待屋主確認維持完整的連結失效時間，已失效寫已失效，沒有期限的狀態是 null', () => {
    expect(practiceDeadlineText({ status: 'pending_owner', deadline: '2026-11-17T02:00:00.000Z' })).toBe('2026/11/17 10:00');
    expect(practiceDeadlineText({ status: 'expired', deadline: null })).toBe('已失效');
    for (const status of ['declined', 'withdrawn', 'ended', 'completed'] as const) {
      expect(practiceDeadlineText({ status, deadline: null })).toBeNull();
    }
  });

  it('接受之後不顯示租賃單位的數量', () => {
    expect(practiceMayShowUnits({ accepted_at: null })).toBe(true);
    expect(practiceMayShowUnits({ accepted_at: '2026-11-10T02:00:00.000Z' })).toBe(false);
  });

  it('只有待業者接受能回覆，只有已接受能結束', () => {
    expect(ALL_STATUSES.filter((s) => practiceCanRespond({ status: s }))).toEqual(['pending_practice']);
    expect(ALL_STATUSES.filter((s) => canEndRequest({ status: s }))).toEqual(['accepted']);
  });

  it('not_pending 一律寫「申請的狀態已改變」，其他錯誤用伺服端的固定訊息', () => {
    expect(decisionErrorText('not_pending', '這份申請已經不是待業者接受的狀態，不能再處理', '失敗')).toBe('申請的狀態已改變');
    expect(decisionErrorText('no_eligible_manager', '貴公司目前沒有通過驗證的租賃住宅管理人員', '失敗')).toBe('貴公司目前沒有通過驗證的租賃住宅管理人員');
    expect(decisionErrorText(undefined, undefined, '失敗')).toBe('失敗');
    expect(decisionErrorReloads('not_pending')).toBe(true);
    expect(decisionErrorReloads('manager_not_eligible')).toBe(false);
  });
});

describe('屋主的下一步與按鈕', () => {
  it('每個狀態都有下一步', () => {
    for (const status of ALL_STATUSES) {
      const step = ownerNextStep(ownerRequest(status));
      expect(step.headline.length).toBeGreaterThan(0);
    }
  });

  it('已接受只寫已接受，未接受只寫三個字，已結束寫是哪一方', () => {
    expect(ownerNextStep(ownerRequest('accepted')).headline).toBe('業者已接受申請');
    const declined = ownerNextStep(ownerRequest('declined', { closed_by: 'practice' }));
    expect(declined.headline).toBe('未接受');
    expect(declined.detail).toBeUndefined();
    expect(ownerNextStep(ownerRequest('ended', { closed_by: 'practice' })).headline).toBe('業者已結束申請，不需要處理');
    expect(ownerNextStep(ownerRequest('ended', { closed_by: 'owner' })).headline).toBe('你已結束申請，不需要處理');
    expect(ownerClosedByText({ status: 'accepted', closed_by: null })).toBeNull();
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

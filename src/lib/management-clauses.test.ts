import { describe, expect, it } from 'vitest';
import { buildManagementClauses, feeText, termText } from './management-clauses';
import type { ManagementContractFields } from './types';

// 委託管理契約書的條文（MIL-74）：欄位進、條文出的純函式。條文是簡化示意，待法務確認（MIL-62、MIL-48）。

const FIELDS: ManagementContractFields = {
  mandatorName: '陳屋主',
  mandatorEmail: 'owner@example.com',
  mandataryName: '王建國',
  mandataryEmail: 'wang@beichen.example.com',
  termStart: '2027-01-01',
  termEnd: '2027-12-31',
  feeMode: 'monthly_fixed',
  feeValue: 3000,
  extra: '',
};

function clause(fields: ManagementContractFields, index: number) {
  return buildManagementClauses(fields)[index];
}

describe('委託管理契約書條文', () => {
  it('條號連號，標題依序是標的、範圍、期間、報酬、義務、專任管理人員、報告、終止', () => {
    expect(buildManagementClauses(FIELDS).map((c) => c.title)).toEqual([
      '第一條　委託標的',
      '第二條　委託範圍',
      '第三條　委託期間',
      '第四條　報酬',
      '第五條　受託人之義務',
      '第六條　專任管理人員',
      '第七條　處理報告',
      '第八條　契約終止',
    ]);
  });

  it('委託標的與範圍引用附件，不在本文列舉', () => {
    expect(clause(FIELDS, 0).body).toContain('附件「委託標的清單」');
    expect(clause(FIELDS, 1).body).toContain('收租、押金管理、修繕、點交');
    expect(clause(FIELDS, 1).body).toContain('不得');
  });

  it('委託期間印起迄日', () => {
    expect(clause(FIELDS, 2).body).toBe('本契約之委託期間自 2027 年 01 月 01 日起至 2027 年 12 月 31 日止。');
  });

  it('委託期間沒填時留底線', () => {
    expect(termText({ ...FIELDS, termStart: '', termEnd: '' })).toBe('自 ＿＿年＿＿月＿＿日起至 ＿＿年＿＿月＿＿日止');
  });

  it('報酬：每月固定金額', () => {
    expect(feeText(FIELDS)).toBe('每月固定新臺幣 3,000 元整');
    expect(clause(FIELDS, 3).body).toContain('每月固定新臺幣 3,000 元整');
  });

  it('報酬：每月租金百分比', () => {
    expect(feeText({ ...FIELDS, feeMode: 'rent_percentage', feeValue: 8 })).toBe('各委託標的每月租金之百分之 8');
  });

  it('報酬沒填時留底線', () => {
    expect(feeText({ ...FIELDS, feeMode: null, feeValue: null })).toBe('＿＿＿＿');
    expect(feeText({ ...FIELDS, feeValue: null })).toBe('＿＿＿＿');
  });

  it('同樣的欄位產出同樣的條文，不讀其他狀態', () => {
    expect(buildManagementClauses(FIELDS)).toEqual(buildManagementClauses({ ...FIELDS }));
  });

  it('條文不含 GLOSSARY 的 Avoid 詞「其他約定事項」', () => {
    expect(buildManagementClauses(FIELDS).map((c) => c.title).join('')).not.toContain('其他約定事項');
  });

  it('條文用甲方、乙方，不用舊用詞', () => {
    const text = buildManagementClauses(FIELDS)
      .map((c) => c.title + c.body)
      .join('');
    expect(text).toContain('甲方（委託人）');
    expect(text).toContain('乙方（受託人）');
    for (const legacy of ['房東', '租客', '業主', '經理人']) expect(text).not.toContain(legacy);
  });
});

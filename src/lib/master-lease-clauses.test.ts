import { describe, expect, it } from 'vitest';
import { bindTemplate } from './clause-library';
import { clauseNumeral } from './contract-clauses';
import {
  MASTER_LEASE_AGREED_POINTS,
  MASTER_LEASE_PROHIBITED_POINTS,
  buildMasterLeaseClauses,
  buildMasterLeaseNoticeClauses,
} from './master-lease-clauses';
import { MASTER_LEASE_TEMPLATE } from './clause-library';
import type { MasterLeaseContractFields } from './types';

// 住宅包租契約範本（MIL-199、ADR-0030 決議 6）：逐點涵蓋公告的應約定事項，並且不含不得約定事項。
// 公告原文在 docs/research/asset-mgmt-platform/legal-sources/master-lease-notice-text.md。

const FIELDS: MasterLeaseContractFields = {
  landlordName: '王大明',
  landlordEmail: 'owner@example.com',
  tenantName: '甲租賃住宅管理股份有限公司',
  tenantEmail: 'ops@example.com',
  propertyName: '信義小宅',
  propertyAddress: '台北市信義區松仁路 1 號 5 樓',
  propertyType: '整層住家',
  propertySize: 25,
  equipmentAnnex: [
    { name: '冷氣', quantity: 2, repair: 'landlord', note: '' },
    { name: '洗衣機', quantity: 1, repair: 'tenant', note: '' },
  ],
  rent: 30000,
  deposit: 60000,
  startDate: '2027-01-01',
  endDate: '2029-12-31',
  payDay: 5,
  extra: '',
  ...bindTemplate([], { template: MASTER_LEASE_TEMPLATE, library: [] }),
};

const clauses = () => buildMasterLeaseNoticeClauses(FIELDS);
const bodyOf = (point: number, fields: MasterLeaseContractFields = FIELDS) =>
  buildMasterLeaseNoticeClauses(fields)[point - 1].body;
const allText = (fields: MasterLeaseContractFields = FIELDS) =>
  buildMasterLeaseNoticeClauses(fields)
    .map((c) => `${c.title}\n${c.body}`)
    .join('\n');

// 每一點必須出現的公告用語。用語取自公告原文，條文改寫成法定稱謂「出租人」「包租業」後仍保留。
const REQUIRED_PHRASES: Record<number, string[]> = {
  1: ['租賃住宅標示', '租賃範圍', '租賃附屬設備', '有無設定他項權利', '有無查封登記'],
  2: ['租賃期間自', '租賃期間不得少於三十日'],
  3: ['包租業每月租金為', '每期應繳納一個月租金', '不得藉任何理由拖延或拒絕', '租金支付方式'],
  4: ['最高不得超過二個月租金之總額', '簽訂住宅包租契約（以下簡稱本契約）之同時給付出租人', '第十三條第三項、第十四條第四項及第十九條第二項'],
  5: ['管理費', '水費', '電費', '瓦斯費', '網路費', '其他費用及其支付方式'],
  6: ['房屋稅、地價稅，由出租人負擔', '銀錢收據應貼用之印花稅票，由出租人負擔', '公證費', '公證代辦費'],
  7: ['供轉租作居住使用', '包租業不得變更用途', '出借或轉租以外之其他方式供他人居住使用', '督促次承租人或使用人遵守公寓大廈規約', '影響公共安全、公共衛生或居住安寧'],
  8: ['應由包租業負責修繕', '另行約定負擔方式', '於第三條約定之租金中扣除'],
  9: ['進行室內裝修', '依相關法令規定辦理，且不得損害原有建築結構之安全', '裝修增設部分若有損壞，由包租業負責修繕並負擔費用', '回復原狀'],
  10: ['有權出租本租賃住宅之證明文件', '同意本租賃標的之全部或一部分轉租之同意書', '合於所約定居住使用之租賃住宅', '負擔修繕費用之項目及範圍', '得終止本契約之事由'],
  11: ['租賃住宅服務業登記證影本', '善良管理人之注意', '不得逾出租人同意轉租之標的範圍及租賃期間', '三十日內', '日常修繕維護並製作紀錄', '開立統一發票或掣給收據', '減徵稅捐', '不得轉讓出租人同意轉租權利及其管理業務', '應負賠償責任'],
  12: ['不可歸責於包租業及次承租人之事由', '請求減少租金'],
  13: ['除第十六條及第十七條規定外', '至少於終止前一個月通知他方', '最高不得超過一個月租金額之違約金', '已預收之租金應返還予包租業'],
  14: ['點交手續', '督促次承租人或使用人遷出戶籍或其他登記', '視為完成點交', '不以不定期限繼續契約', '押金中抵充'],
  15: ['對於受讓人仍繼續存在', '移交押金及已預收之租金予受讓人', '其期限逾五年者，不適用第一項之規定'],
  16: ['重新建築而必要收回', '遲付租金之總額達二個月之金額', '主管機關撤銷、廢止其許可或登記', '終止前三個月', '終止前三十日', '有危害公共安全'],
  17: ['應由出租人負擔修繕費用', '存餘部分不能達租賃之目的', '危及次承租人或其同居人之安全或健康之瑕疵', '第三人就租賃住宅主張其權利', '終止前三十日'],
  18: ['五日內通知次承租人終止轉租契約', '租賃住宅服務商業同業公會或其全國聯合會', '不得拒絕', '應負賠償責任'],
  19: ['視為拋棄其所有權', '押金中抵充'],
  20: ['以郵寄為之者', '第一次郵遞之日期推定為到達日', '電子郵件信箱'],
  21: ['辦理公證', '逕受強制執行', '前項後段第（二）款之效力及於保證人'],
  22: ['完成電子簽署之日（簽約日）起生效', '各自留存一份電子檔', '廣告及相關附件視為本契約之一部分'],
  23: ['戶籍地址', '通訊地址', '聯絡電話', '代表人姓名', '統一編號', '登記證字號', '營業地址', '電子郵件信箱', '證書字號'],
};

// 不得約定事項七點：每一點給一組不得出現在條文的樣式。
const PROHIBITED_PATTERNS: Record<number, RegExp[]> = {
  1: [/廣告[^。\n]*僅供參考/, /僅供參考/],
  2: [/不得遷入戶籍/, /不得設籍/, /不得辦理戶籍/],
  3: [/轉嫁/, /包租業負擔之稅[^。\n]*由出租人負擔/, /稅[^。\n]*由出租人負擔[^。\n]*包租業應負擔/],
  4: [/免除[^。\n]*瑕疵擔保/, /限制[^。\n]*瑕疵擔保/, /不負瑕疵擔保/],
  5: [/繳回契約書/, /繳回[^。\n]*契約/, /返還契約書/],
  6: [/僅以電話/, /僅得以電話/, /以電話為限/],
  7: [/違反強制/, /排除[^。\n]*強制規定/],
};

describe('住宅包租契約範本：應約定事項涵蓋', () => {
  it('公告應約定事項二十三點，每一點恰有一條條文，條號與點次相同', () => {
    expect(MASTER_LEASE_AGREED_POINTS).toHaveLength(23);
    const built = clauses();
    expect(built).toHaveLength(23);
    built.forEach((clause, index) => {
      const point = MASTER_LEASE_AGREED_POINTS[index];
      expect(point.point).toBe(index + 1);
      expect(clause.title).toBe(`第${clauseNumeral(index + 1)}條　${point.title}`);
      expect(clause.notice).toBe(`應約定事項第${clauseNumeral(index + 1)}點`);
    });
  });

  it.each(MASTER_LEASE_AGREED_POINTS.map((p) => [p.point, p.title] as const))('第 %i 點「%s」的公告用語都在條文裡', (point) => {
    const body = bodyOf(point);
    for (const phrase of REQUIRED_PHRASES[point]) {
      expect(body, `第 ${point} 點缺少：${phrase}`).toContain(phrase);
    }
  });

  it('REQUIRED_PHRASES 涵蓋每一點', () => {
    expect(Object.keys(REQUIRED_PHRASES).map(Number).sort((a, b) => a - b)).toEqual(
      MASTER_LEASE_AGREED_POINTS.map((p) => p.point),
    );
  });

  it('帶入欄位值：地址、設備、期間、租金、押金、付款日、當事人', () => {
    const text = allText();
    expect(text).toContain('台北市信義區松仁路 1 號 5 樓');
    expect(text).toContain('冷氣×2、洗衣機×1');
    expect(text).toContain('自 2027 年 01 月 01 日起至 2029 年 12 月 31 日止');
    expect(text).toContain('每月租金為新臺幣 30,000 元整');
    expect(text).toContain('押金由租賃雙方約定為 2 個月租金，金額為新臺幣 60,000 元整');
    expect(text).toContain('每月 5 日前支付');
    expect(text).toContain('王大明');
    expect(text).toContain('甲租賃住宅管理股份有限公司');
  });

  it('沒填的欄位留底線，不留空白也不猜值', () => {
    const empty = { ...FIELDS, rent: null, deposit: null, payDay: null, propertyAddress: '' };
    expect(bodyOf(3, empty)).toContain('＿＿＿＿');
    expect(bodyOf(4, empty)).toContain('押金由租賃雙方約定為 ＿＿ 個月租金');
    expect(bodyOf(1, empty)).toContain('＿＿＿＿＿＿');
  });

  it('公告內「第 X 點」的引用改寫成「第 X 條」，且引用的條號存在', () => {
    const text = allText();
    expect(text).not.toMatch(/第[〇一二三四五六七八九十]+點/);
    for (const match of text.matchAll(/第([一二三四五六七八九十]+)條/g)) {
      const referenced = MASTER_LEASE_AGREED_POINTS.findIndex((_, i) => clauseNumeral(i + 1) === match[1]);
      expect(referenced, `引用不存在的條號：第${match[1]}條`).toBeGreaterThanOrEqual(0);
    }
  });

  it('文件上不印「甲方」「乙方」，用法定稱謂（ADR-0030 決議 7）', () => {
    const text = allText();
    expect(text).not.toContain('甲方');
    expect(text).not.toContain('乙方');
    expect(text).toContain('出租人');
    expect(text).toContain('包租業');
    expect(text).toContain('次承租人');
  });

  it('沒有舊用詞', () => {
    const text = allText();
    for (const legacy of ['房東', '租客', '房客', '出租方', '承租方', '業主', '經理人']) {
      expect(text).not.toContain(legacy);
    }
  });

  it('選項依欄位變化，預設值是不同意與回復原狀', () => {
    expect(bodyOf(7)).toContain('出租人不同意包租業將本租賃住宅以出借或轉租以外之其他方式');
    expect(bodyOf(9)).toContain('出租人不同意包租業將本租賃住宅之全部或一部分進行室內裝修');
    expect(bodyOf(9)).toContain('應負責回復原狀');
    expect(bodyOf(13)).toContain('租賃雙方不得就租賃住宅之全部或一部終止租約');
    expect(bodyOf(21)).toContain('租賃雙方不同意辦理公證');
    const custom: MasterLeaseContractFields = {
      ...FIELDS,
      terms: {
        otherUse: 'allowed',
        renovation: 'allowed',
        renovationCostPayer: 'party_a',
        restoreOnReturn: 'as_is',
        earlyTermination: 'allowed',
        notarization: 'agreed',
        scope: 'part',
        scopeNote: '主臥與客廳',
        rentPaymentMethod: 'cash',
        feePayers: { management: 'party_b' },
      },
    };
    expect(bodyOf(7, custom)).toContain('出租人同意包租業將本租賃住宅以出借或轉租以外之其他方式');
    expect(bodyOf(9, custom)).toContain('出租人同意包租業將本租賃住宅之全部或一部分進行室內裝修');
    expect(bodyOf(9, custom)).toContain('由出租人負擔');
    expect(bodyOf(9, custom)).toContain('現況返還');
    expect(bodyOf(13, custom)).toContain('租賃雙方得就租賃住宅之全部或一部終止租約');
    expect(bodyOf(21, custom)).toContain('租賃雙方同意辦理公證');
    expect(bodyOf(1, custom)).toContain('租賃住宅一部：主臥與客廳');
    expect(bodyOf(3, custom)).toContain('現金繳付');
    expect(bodyOf(5, custom)).toContain('管理費：由包租業負擔');
  });

  it('其他約定事項收在第二十一條，條號不受影響', () => {
    const withExtra = { ...FIELDS, extra: '包租業應每季提供收支報告。' };
    expect(bodyOf(21, withExtra)).toContain('其他約定事項：包租業應每季提供收支報告。');
    expect(bodyOf(21)).toContain('其他約定事項：無。');
    expect(buildMasterLeaseNoticeClauses(withExtra)).toHaveLength(23);
  });

  it('buildMasterLeaseClauses 回傳與條文相同的標題與本文', () => {
    expect(buildMasterLeaseClauses(FIELDS)).toEqual(clauses().map(({ title, body }) => ({ title, body })));
  });
});

describe('住宅包租契約範本：不得約定事項反向檢查', () => {
  it('公告不得約定事項七點都有檢查樣式', () => {
    expect(MASTER_LEASE_PROHIBITED_POINTS).toHaveLength(7);
    expect(Object.keys(PROHIBITED_PATTERNS).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it.each(MASTER_LEASE_PROHIBITED_POINTS.map((p) => [p.point, p.title] as const))('不得約定第 %i 點：%s', (point) => {
    // 預設值與各種選項組合下，條文都不含這一點禁止的約定
    const variants: MasterLeaseContractFields[] = [
      FIELDS,
      {
        ...FIELDS,
        extra: '無。',
        terms: { otherUse: 'allowed', renovation: 'allowed', earlyTermination: 'allowed', notarization: 'agreed', scope: 'part', scopeNote: '一間房' },
      },
    ];
    for (const fields of variants) {
      for (const pattern of PROHIBITED_PATTERNS[point]) {
        expect(allText(fields)).not.toMatch(pattern);
      }
    }
  });

  it('正面寫出相反的約定', () => {
    const text = allText();
    // 1 廣告視為契約之一部分
    expect(text).toContain('本契約廣告及相關附件視為本契約之一部分');
    // 2 包租業督促次承租人遷出戶籍，沒有禁止遷入
    expect(text).toContain('遷出戶籍或其他登記');
    // 3 房屋稅、地價稅由出租人負擔，包租業負擔的稅費不轉嫁
    expect(text).toContain('租賃住宅之房屋稅、地價稅，由出租人負擔');
    // 5 契約雙方各自留存
    expect(text).toContain('各自留存一份電子檔');
    // 6 通知有郵寄與電子郵件
    expect(text).toContain('以郵寄為之者');
    expect(text).toContain('電子郵件信箱');
    // 7 條文要求依法令辦理
    expect(text).toContain('依相關法令規定辦理');
    expect(text).toContain('不得違法使用');
  });
});

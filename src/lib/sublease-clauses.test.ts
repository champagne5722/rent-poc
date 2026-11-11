import { describe, expect, it } from 'vitest';
import { SUBLEASE_TEMPLATE, bindTemplate } from './clause-library';
import { clauseNumeral } from './contract-clauses';
import {
  SUBLEASE_PROHIBITED_POINTS,
  SUBLEASE_RECORDED_POINTS,
  buildSubleaseClauses,
  buildSubleaseNoticeClauses,
} from './sublease-clauses';
import type { SubleaseContractFields } from './types';

// 住宅轉租契約範本（MIL-199、ADR-0030 決議 6）：逐點涵蓋公告的應記載事項，並且不含不得記載事項。
// 公告原文（113 年 11 月 21 日修正版）在 docs/research/asset-mgmt-platform/legal-sources/sublease-notice-text.md。

const FIELDS: SubleaseContractFields = {
  landlordName: '甲租賃住宅管理股份有限公司',
  landlordEmail: 'ops@example.com',
  tenantName: '李小姐',
  tenantEmail: 'lee@example.com',
  propertyName: '信義小宅',
  propertyAddress: '台北市信義區松仁路 1 號 5 樓',
  propertyType: '整層住家',
  propertySize: 25,
  equipmentAnnex: [{ name: '冷氣', quantity: 2, repair: 'landlord', note: '' }],
  rent: 32000,
  deposit: 64000,
  startDate: '2027-02-01',
  endDate: '2027-12-31',
  payDay: 10,
  extra: '',
  masterLeaseStart: '2027-01-01',
  masterLeaseEnd: '2029-12-31',
  ...bindTemplate([], { template: SUBLEASE_TEMPLATE, library: [] }),
};

const bodyOf = (point: number, fields: SubleaseContractFields = FIELDS) =>
  buildSubleaseNoticeClauses(fields)[point - 1].body;
const allText = (fields: SubleaseContractFields = FIELDS) =>
  buildSubleaseNoticeClauses(fields)
    .map((c) => `${c.title}\n${c.body}`)
    .join('\n');

// 每一點必須出現的公告用語。用語取自公告原文，條文改寫成法定稱謂「包租業」「承租人」「原出租人」後仍保留。
const REQUIRED_PHRASES: Record<number, string[]> = {
  1: ['契約審閱期間至少三日', '攜回審閱'],
  2: ['租賃住宅標示', '租賃範圍', '租賃附屬設備', '租賃標的現況確認書', '附件一'],
  3: ['租賃期間不得少於三十日', '並不得逾包租契約之租賃期間'],
  4: ['承租人每月租金為', '不得藉任何理由拖延或拒絕', '包租業於租賃期間亦不得藉任何理由要求調漲租金', '租金支付方式'],
  5: ['最高不得超過二個月租金之總額', '承租人應於簽訂本契約之同時給付包租業', '第十四條第三項、第十五條第四項及第二十條第二項'],
  6: ['管理費', '水費', '電費', '瓦斯費', '網路費', '其他費用及其支付方式', '當期每度平均電價', '包租業不得額外收取'],
  7: ['銀錢收據應貼用之印花稅票，由包租業負擔', '營業稅法規定應開立發票報繳之營業稅，由包租業負擔', '公證費', '公證代辦費'],
  8: ['供居住使用', '承租人不得變更用途', '遵守公寓大廈規約', '不得將本租賃住宅之全部或一部分轉租，或將租賃權轉讓於他人'],
  9: ['應由包租業負責修繕', '可歸責於承租人之事由', '得自行修繕，並請求包租業償還其費用', '先期通知', '扣除該期間全部或一部之租金'],
  10: ['應經包租業同意並依相關法令規定辦理', '不得損害原有建築結構之安全', '裝修增設部分若有損壞，由承租人負責修繕', '回復原狀'],
  11: ['租賃住宅服務業登記證影本', '同意轉租之書面文件', '原出租人', '合於所約定居住使用之租賃住宅', '負責修繕項目及範圍', '租賃標的現況確認書', '開立統一發票或掣給收據', '日常修繕維護並製作紀錄', '協助向原出租人取得可供設籍之相關證明', '提供承租人租賃標的之電費資訊', '台灣電力股份有限公司'],
  12: ['出示國民身分證', '善良管理人之注意', '損害賠償責任'],
  13: ['不可歸責於承租人之事由', '請求減少租金'],
  14: ['除第十七條及第十八條規定外', '至少於終止前一個月通知他方', '最高不得超過一個月租金額之違約金', '已預收之租金應返還予承租人'],
  15: ['點交手續', '遷出戶籍或其他登記', '視為完成點交', '不以不定期限繼續契約', '押金中抵充'],
  16: ['包租契約對於受讓人仍繼續存在', '以書面通知承租人'],
  17: ['原出租人為重新建築而必要收回', '遲付租金之總額達二個月之金額', '終止前三個月', '終止前三十日', '有公共安全之危害情形者，得不先期通知'],
  18: ['未合於居住使用，並有修繕之必要', '危及承租人或其同居人之安全或健康之瑕疵', '長期療養之需要', '第三人就租賃住宅主張其權利', '主管機關撤銷、廢止其許可或登記', '繼承人得主張終止租約'],
  19: ['五日內通知承租人終止本契約', '協助承租人優先承租其他租賃住宅', '同業公會', '應負賠償責任'],
  20: ['視為拋棄其所有權', '押金中抵充'],
  21: ['以郵寄為之者', '第一次郵遞之日期推定為到達日', '電子郵件信箱'],
  22: ['辦理公證', '逕受強制執行', '前項後段第（二）款之效力及於保證人'],
  23: ['完成電子簽署之日（簽約日）起生效', '各自留存一份電子檔', '廣告及相關附件視為本契約之一部分'],
  24: ['戶籍地址', '通訊地址', '聯絡電話', '代表人姓名', '統一編號', '登記證字號', '營業地址', '電子郵件信箱', '證書字號'],
};

// 不得記載事項十點：每一點給一組不得出現在條文的樣式。
const PROHIBITED_PATTERNS: Record<number, RegExp[]> = {
  1: [/拋棄審閱期間(?!。)/, /放棄審閱/, /不須審閱/],
  2: [/廣告[^。\n]*僅供參考/, /僅供參考/],
  3: [/不得申報租賃費用支出(?!之權利)/, /不得申報/],
  4: [/不得遷入戶籍/, /不得設籍/],
  5: [/稅[^。\n]*增加[^。\n]*由承租人負擔/, /較出租前增加/],
  6: [/免除[^。\n]*瑕疵擔保/, /限制[^。\n]*瑕疵擔保/, /不負瑕疵擔保/],
  7: [/繳回契約書/, /繳回[^。\n]*契約/],
  8: [/僅以電話/, /僅得以電話/],
  9: [/違反強制/],
  10: [/不得申請租金補貼/, /放棄[^。\n]*租金補貼/],
};

describe('住宅轉租契約範本：應記載事項涵蓋', () => {
  it('公告應記載事項二十四點，每一點恰有一條條文，條號與點次相同', () => {
    expect(SUBLEASE_RECORDED_POINTS).toHaveLength(24);
    const built = buildSubleaseNoticeClauses(FIELDS);
    expect(built).toHaveLength(24);
    built.forEach((clause, index) => {
      const point = SUBLEASE_RECORDED_POINTS[index];
      expect(point.point).toBe(index + 1);
      expect(clause.title).toBe(`第${clauseNumeral(index + 1)}條　${point.title}`);
      expect(clause.notice).toBe(`應記載事項第${clauseNumeral(index + 1)}點`);
    });
  });

  it.each(SUBLEASE_RECORDED_POINTS.map((p) => [p.point, p.title] as const))('第 %i 點「%s」的公告用語都在條文裡', (point) => {
    const body = bodyOf(point);
    for (const phrase of REQUIRED_PHRASES[point]) {
      expect(body, `第 ${point} 點缺少：${phrase}`).toContain(phrase);
    }
  });

  it('REQUIRED_PHRASES 涵蓋每一點', () => {
    expect(Object.keys(REQUIRED_PHRASES).map(Number).sort((a, b) => a - b)).toEqual(
      SUBLEASE_RECORDED_POINTS.map((p) => p.point),
    );
  });

  it('帶入欄位值：地址、設備、期間、包租契約期間、租金、押金、付款日、當事人', () => {
    const text = allText();
    expect(text).toContain('台北市信義區松仁路 1 號 5 樓');
    expect(text).toContain('冷氣×2');
    expect(text).toContain('自 2027 年 02 月 01 日起至 2027 年 12 月 31 日止');
    expect(text).toContain('包租契約之租賃期間自 2027 年 01 月 01 日起至 2029 年 12 月 31 日止');
    expect(text).toContain('承租人每月租金為新臺幣 32,000 元整');
    expect(text).toContain('押金由租賃雙方約定為 2 個月租金，金額為新臺幣 64,000 元整');
    expect(text).toContain('每月 10 日前支付');
    expect(text).toContain('李小姐');
    expect(text).toContain('甲租賃住宅管理股份有限公司');
  });

  it('沒填的欄位留底線，包租契約期間沒填時不印期間', () => {
    const empty = { ...FIELDS, rent: null, deposit: null, masterLeaseStart: undefined, masterLeaseEnd: undefined };
    expect(bodyOf(4, empty)).toContain('＿＿＿＿');
    expect(bodyOf(5, empty)).toContain('押金由租賃雙方約定為 ＿＿ 個月租金');
    expect(bodyOf(3, empty)).not.toContain('（包租契約之租賃期間');
  });

  it('公告內「第 X 點」的引用改寫成「第 X 條」，且引用的條號存在', () => {
    const text = allText();
    expect(text).not.toMatch(/第[〇一二三四五六七八九十]+點/);
    for (const match of text.matchAll(/第([一二三四五六七八九十]+)條/g)) {
      const referenced = SUBLEASE_RECORDED_POINTS.findIndex((_, i) => clauseNumeral(i + 1) === match[1]);
      expect(referenced, `引用不存在的條號：第${match[1]}條`).toBeGreaterThanOrEqual(0);
    }
  });

  it('文件上不印「甲方」「乙方」，用法定稱謂（ADR-0030 決議 7）', () => {
    const text = allText();
    expect(text).not.toContain('甲方');
    expect(text).not.toContain('乙方');
    expect(text).toContain('包租業');
    expect(text).toContain('承租人');
    expect(text).toContain('原出租人');
  });

  it('沒有舊用詞', () => {
    const text = allText();
    for (const legacy of ['房東', '租客', '房客', '出租方', '承租方', '業主', '經理人']) {
      expect(text).not.toContain(legacy);
    }
  });

  it('選項依欄位變化：電費計費方式、管理費增加上限、回復原狀與公證', () => {
    expect(bodyOf(6)).toContain('每度電費不得超過');
    expect(bodyOf(6)).not.toContain('每期電費總金額，不得超過');
    expect(bodyOf(6)).not.toContain('以負擔百分之十為限');
    expect(bodyOf(10)).toContain('應負責回復原狀');
    expect(bodyOf(14)).toContain('租賃雙方不得終止租約');
    expect(bodyOf(22)).toContain('租賃雙方不同意辦理公證');
    const custom: SubleaseContractFields = {
      ...FIELDS,
      terms: {
        electricityBilling: 'per_period',
        feePayers: { management: 'party_b' },
        restoreOnReturn: 'as_is',
        earlyTermination: 'allowed',
        notarization: 'agreed',
      },
    };
    expect(bodyOf(6, custom)).toContain('每期電費總金額，不得超過');
    expect(bodyOf(6, custom)).toContain('以負擔百分之十為限');
    expect(bodyOf(10, custom)).toContain('現況返還');
    expect(bodyOf(14, custom)).toContain('租賃雙方得終止租約');
    expect(bodyOf(22, custom)).toContain('租賃雙方同意辦理公證');
  });

  it('其他約定事項收在第二十二條，條號不受影響', () => {
    const withExtra = { ...FIELDS, extra: '承租人得養一隻貓。' };
    expect(bodyOf(22, withExtra)).toContain('其他約定事項：承租人得養一隻貓。');
    expect(bodyOf(22)).toContain('其他約定事項：無。');
    expect(buildSubleaseNoticeClauses(withExtra)).toHaveLength(24);
  });

  it('buildSubleaseClauses 回傳與條文相同的標題與本文', () => {
    expect(buildSubleaseClauses(FIELDS)).toEqual(buildSubleaseNoticeClauses(FIELDS).map(({ title, body }) => ({ title, body })));
  });
});

describe('住宅轉租契約範本：不得記載事項反向檢查', () => {
  it('公告不得記載事項十點都有檢查樣式', () => {
    expect(SUBLEASE_PROHIBITED_POINTS).toHaveLength(10);
    expect(Object.keys(PROHIBITED_PATTERNS).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it.each(SUBLEASE_PROHIBITED_POINTS.map((p) => [p.point, p.title] as const))('不得記載第 %i 點：%s', (point) => {
    const variants: SubleaseContractFields[] = [
      FIELDS,
      {
        ...FIELDS,
        extra: '無。',
        terms: { earlyTermination: 'allowed', notarization: 'agreed', feePayers: { management: 'party_b' }, restoreOnReturn: 'as_is' },
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
    // 1 審閱期至少三日，包租業不得要求拋棄
    expect(bodyOf(1)).toContain('不得要求承租人拋棄審閱期間');
    // 2 廣告視為契約之一部分
    expect(text).toContain('包租業之廣告及相關附件視為本契約之一部分');
    // 3、10 申報租賃費用支出與申請租金補貼的權利不受影響
    expect(text).toContain('不影響承租人依法申報租賃費用支出及申請租金補貼之權利');
    // 4 包租業協助承租人設立戶籍
    expect(text).toContain('協助向原出租人取得可供設籍之相關證明');
    // 5 包租業負擔營業稅與印花稅
    expect(text).toContain('營業稅，由包租業負擔');
    // 7 契約雙方各自留存
    expect(text).toContain('各自留存一份電子檔');
    // 8 通知有郵寄與電子郵件
    expect(text).toContain('以郵寄為之者');
    expect(text).toContain('電子郵件信箱');
    // 9 條文要求依法令辦理
    expect(text).toContain('依相關法令規定辦理');
  });
});

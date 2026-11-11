// 住宅包租契約的條文（MIL-199、ADR-0030 決議 6、P0-10）。
//
// 依內政部「住宅包租契約應約定及不得約定事項」撰寫。公告原文見
// docs/research/asset-mgmt-platform/legal-sources/master-lease-notice-text.md（108 年 2 月 23 日內授中辦地字第 1080260693 號令）。
// 條號與公告的點次一一對應：第 N 條就是應約定事項第 N 點，公告內「第 X 點」的引用改寫成「第 X 條」。
// 公告的選項（□…□…）存在 `fields.terms`，沒填的用 lease-family-terms.ts 的預設值，預設值待法務確認（MIL-62）。
//
// 不得約定事項七點不另成條文，而是用測試守住：條文不得含這七種約定，並且正面寫出相反的約定（見測試）。
// 範本 v1 是未經法務審閱的版本（legalReviewed=false），正式金鑰下無法送簽。
//
// 當事人稱謂照公告原文：出租人與包租業，轉租的對象稱次承租人。文件上不印「甲方」「乙方」（ADR-0030 決議 7）。
// 只有純函式與字串（不碰 fs / pdf-lib），所以 client 端的 wizard 也能引用，PDF 與確認頁吃同一份。

import { blank, fmtDate, fmtMoney } from './contract-clauses';
import {
  depositMonthsText,
  resolveLeaseFamilyTerms,
  type ResolvedLeaseFamilyTerms,
} from './lease-family-terms';
import {
  equipmentText,
  feeLines,
  items,
  managerContactLine,
  numberClauses,
  paragraphs,
  partyContactLine,
  propertyMarkText,
  rentPaymentText,
  type ClauseSpec,
  type NoticeClause,
  type NoticePoint,
} from './lease-family-clauses';
import { partyLabels } from './labels';
import type { MasterLeaseContractFields } from './types';

const LABELS = partyLabels('master_lease');
const LESSOR = LABELS.partyA; // 出租人
const OPERATOR = LABELS.partyB; // 包租業

/** 公告「應約定事項」的二十三點，點次與標題照公告原文。涵蓋測試用它核對條文。 */
export const MASTER_LEASE_AGREED_POINTS: readonly NoticePoint[] = [
  { point: 1, title: '租賃標的' },
  { point: 2, title: '租賃期間' },
  { point: 3, title: '租金約定及支付' },
  { point: 4, title: '押金約定及返還' },
  { point: 5, title: '租賃期間相關費用之支付' },
  { point: 6, title: '稅費負擔之約定' },
  { point: 7, title: '使用租賃住宅之限制' },
  { point: 8, title: '修繕' },
  { point: 9, title: '室內裝修' },
  { point: 10, title: '出租人之義務及責任' },
  { point: 11, title: '包租業之義務及責任' },
  { point: 12, title: '租賃住宅部分滅失' },
  { point: 13, title: '提前終止租約之約定' },
  { point: 14, title: '租賃住宅之返還' },
  { point: 15, title: '租賃住宅所有權之讓與' },
  { point: 16, title: '出租人提前終止租約' },
  { point: 17, title: '包租業提前終止租約' },
  { point: 18, title: '出租人提前終止租約之處理' },
  { point: 19, title: '遺留物之處理' },
  { point: 20, title: '履行本契約之通知' },
  { point: 21, title: '其他約定' },
  { point: 22, title: '契約及其相關附件效力' },
  { point: 23, title: '當事人及相關人員基本資料' },
];

/** 公告「不得約定事項」的七點，點次與內容照公告原文。反向測試用它列出每一點。 */
export const MASTER_LEASE_PROHIBITED_POINTS: readonly NoticePoint[] = [
  { point: 1, title: '不得約定廣告僅供參考' },
  { point: 2, title: '不得約定次承租人不得遷入戶籍' },
  { point: 3, title: '不得約定應由包租業負擔之稅費，轉嫁由出租人負擔' },
  { point: 4, title: '不得約定免除或限制民法上出租人故意不告知之瑕疵擔保責任' },
  { point: 5, title: '不得約定出租人須繳回契約書' },
  { point: 6, title: '不得約定本契約之通知，僅以電話方式為之' },
  { point: 7, title: '不得約定違反強制或禁止規定' },
];

function dateRange(f: MasterLeaseContractFields): string {
  return `自 ${fmtDate(f.startDate)}起至 ${fmtDate(f.endDate)}止`;
}

function choice(allowed: boolean, yes: string, no: string): string {
  return allowed ? yes : no;
}

function specs(f: MasterLeaseContractFields): ClauseSpec[] {
  const t: ResolvedLeaseFamilyTerms = resolveLeaseFamilyTerms(f.terms);
  const payer = (p: 'party_a' | 'party_b') => (p === 'party_a' ? LESSOR : OPERATOR);
  const scopeText = t.scope === 'whole' ? '全部' : `一部：${blank(t.scopeNote)}`;
  const notarized = t.notarization === 'agreed';

  return [
    // 1
    {
      title: '租賃標的',
      body: paragraphs(
        items([
          `租賃住宅標示：${propertyMarkText(f)}。土地與建物登記資料（基地坐落、建號、權利範圍、面積）、車位、有無設定他項權利、有無查封登記：${blank(t.titleNote)}。`,
          `租賃範圍：租賃住宅${scopeText}。`,
          `租賃附屬設備：${equipmentText(f)}`,
        ]),
      ),
    },
    // 2
    {
      title: '租賃期間',
      body: `租賃期間${dateRange(f)}。租賃期間不得少於三十日。`,
    },
    // 3
    {
      title: '租金約定及支付',
      body: paragraphs(
        `${OPERATOR}每月租金為${fmtMoney(f.rent)}，每期應繳納一個月租金，並於每月 ${
          f.payDay != null ? f.payDay : '＿＿'
        } 日前支付，不得藉任何理由拖延或拒絕。`,
        `租金支付方式：${rentPaymentText(t)}`,
      ),
    },
    // 4
    {
      title: '押金約定及返還',
      body: paragraphs(
        `押金由租賃雙方約定為 ${depositMonthsText(f.rent, f.deposit)} 個月租金，金額為${fmtMoney(
          f.deposit,
        )}（最高不得超過二個月租金之總額）。${OPERATOR}應於簽訂住宅包租契約（以下簡稱本契約）之同時給付${LESSOR}。`,
        `前項押金，除有第十三條第三項、第十四條第四項及第十九條第二項得抵充之情形外，${LESSOR}應於租期屆滿或租賃契約終止，${OPERATOR}返還租賃住宅時，返還押金或抵充本契約所生債務後之賸餘押金。`,
      ),
    },
    // 5
    {
      title: '租賃期間相關費用之支付',
      body: paragraphs(
        '租賃期間，使用租賃住宅所生之相關費用如下：',
        items(feeLines(t, { partyA: LESSOR, partyB: OPERATOR }, { tenantBearsLimits: false })),
      ),
    },
    // 6
    {
      title: '稅費負擔之約定',
      body: paragraphs(
        '本契約有關稅費，依下列約定辦理：',
        items([
          `租賃住宅之房屋稅、地價稅，由${LESSOR}負擔。`,
          `${LESSOR}收取現金者，其銀錢收據應貼用之印花稅票，由${LESSOR}負擔。`,
          '其他稅費及其支付方式：依相關法令規定辦理，法令未規定者由租賃雙方另行約定。',
        ]),
        '本契約租賃雙方同意辦理公證者，其有關費用依下列約定辦理：',
        items(['公證費，由租賃雙方平均負擔。', '公證代辦費，由租賃雙方平均負擔。']),
      ),
    },
    // 7
    {
      title: '使用租賃住宅之限制',
      body: paragraphs(
        `本租賃住宅係供轉租作居住使用，${OPERATOR}不得變更用途。`,
        `${LESSOR}${choice(t.otherUse === 'allowed', '同意', '不同意')}${OPERATOR}將本租賃住宅以出借或轉租以外之其他方式供他人居住使用。`,
        `${OPERATOR}轉租本租賃住宅或經${LESSOR}同意提供他人使用者，應督促次承租人或使用人遵守公寓大廈規約或其他住戶應遵行事項，不得違法使用、存放有爆炸性或易燃性物品，影響公共安全、公共衛生或居住安寧。`,
      ),
    },
    // 8
    {
      title: '修繕',
      body: paragraphs(
        `租賃住宅或附屬設備損壞時，應由${OPERATOR}負責修繕，其修繕費用，得由租賃雙方視損壞性質及責任歸屬，另行約定負擔方式。`,
        `前項約定由${LESSOR}負擔修繕費用者，${OPERATOR}得請求${LESSOR}償還其費用或於第三條約定之租金中扣除。`,
      ),
    },
    // 9
    {
      title: '室內裝修',
      body: paragraphs(
        `${LESSOR}${choice(t.renovation === 'allowed', '同意', '不同意')}${OPERATOR}將本租賃住宅之全部或一部分進行室內裝修。`,
        `前項經${LESSOR}同意室內裝修者，${OPERATOR}應依相關法令規定辦理，且不得損害原有建築結構之安全。`,
        `第一項室內裝修所需費用，由${payer(t.renovationCostPayer)}負擔。`,
        `${OPERATOR}經${LESSOR}同意裝修者，其裝修增設部分若有損壞，由${OPERATOR}負責修繕並負擔費用。`,
        `第二項情形，${OPERATOR}返還租賃住宅時，${choice(t.restoreOnReturn === 'restore', '應負責回復原狀', '現況返還')}。`,
      ),
    },
    // 10
    {
      title: '出租人之義務及責任',
      body: paragraphs(
        `本契約租賃期間，${LESSOR}之義務及責任如下：`,
        items([
          `應出示有權出租本租賃住宅之證明文件及國民身分證或其他足資證明身分之文件，供${OPERATOR}核對。`,
          `應於簽訂本契約時，提供同意本租賃標的之全部或一部分轉租之同意書，並載明租賃標的範圍、租賃期間及得終止本契約之事由。`,
          `應以合於所約定居住使用之租賃住宅，交付${OPERATOR}，並於租賃期間保持其合於居住使用之狀態。`,
          `簽訂本契約，應先向${OPERATOR}說明租賃住宅由${LESSOR}負擔修繕費用之項目及範圍，並提供有修繕必要時之聯絡方式。`,
        ]),
        `前項第二款、第四款之同意轉租及負擔修繕費用之項目、範圍如下。同意轉租範圍：租賃住宅${scopeText}。同意轉租期間：同本契約之租賃期間，${dateRange(f)}。得終止本契約之事由：依第十六條之約定。${LESSOR}負擔修繕費用之項目及範圍：${blank(t.repairScopeNote)}。${LESSOR}簽署本契約，即為提供前項第二款之同意書。`,
      ),
    },
    // 11
    {
      title: '包租業之義務及責任',
      body: paragraphs(
        `本契約租賃期間，${OPERATOR}之義務及責任如下：`,
        items([
          `應出示租賃住宅服務業登記證影本，供${LESSOR}核對。`,
          '應以善良管理人之注意，保管、使用、收益租賃住宅。',
          `與次承租人簽訂轉租契約時，不得逾${LESSOR}同意轉租之標的範圍及租賃期間。`,
          `應於簽訂轉租契約後三十日內，以書面將轉租標的範圍、租賃期間、次承租人之姓名及其通訊地址等相關資料通知${LESSOR}。`,
          `應執行日常修繕維護並製作紀錄，提供${LESSOR}查詢或取閱。`,
          `應於收受${LESSOR}之有關費用或文件時，開立統一發票或掣給收據。`,
          `應配合${LESSOR}申請減徵稅捐需要，提供相關證明。`,
          `不得轉讓${LESSOR}同意轉租權利及其管理業務。`,
        ]),
        `${OPERATOR}違反前項各款規定之一，致${LESSOR}受有損害者，應負賠償責任。但前項第二款情形，${OPERATOR}依約定之方法或依租賃住宅之性質使用、收益，致有變更或毀損者，不在此限。`,
      ),
    },
    // 12
    {
      title: '租賃住宅部分滅失',
      body: `租賃關係存續中，因不可歸責於${OPERATOR}及次承租人之事由，致租賃住宅之一部滅失者，${OPERATOR}得按滅失之部分，請求減少租金。`,
    },
    // 13
    {
      title: '提前終止租約之約定',
      body: paragraphs(
        `本契約於期限屆滿前，除第十六條及第十七條規定外，租賃雙方${choice(t.earlyTermination === 'allowed', '得', '不得')}就租賃住宅之全部或一部終止租約。`,
        '依約定得終止租約者，租賃之一方應至少於終止前一個月通知他方。一方未為先期通知而逕行終止租約者，應賠償他方最高不得超過一個月租金額之違約金。',
        `前項${OPERATOR}應賠償之違約金得由第四條第一項規定之押金中抵充。`,
        `租期屆滿前，依第二項規定終止租約者，${LESSOR}已預收之租金應返還予${OPERATOR}。`,
      ),
    },
    // 14
    {
      title: '租賃住宅之返還',
      body: paragraphs(
        `租期屆滿或租賃契約終止時，${OPERATOR}應即結算第五條約定之相關費用，並會同${LESSOR}共同完成屋況及附屬設備之點交手續，${OPERATOR}應將租賃住宅返還${LESSOR}並督促次承租人或使用人遷出戶籍或其他登記。`,
        '前項租賃之一方未會同點交，經他方定相當期限催告仍不會同者，視為完成點交。',
        `${OPERATOR}未依第一項規定返還租賃住宅時，${LESSOR}應明示不以不定期限繼續契約，並得向${OPERATOR}請求未返還租賃住宅期間之相當月租金額，及相當月租金額計算之違約金（未足一個月者，以日租金折算）至返還為止。`,
        `前項金額及${OPERATOR}未繳清第五條約定之相關費用，${LESSOR}得由第四條第一項規定之押金中抵充。`,
      ),
    },
    // 15
    {
      title: '租賃住宅所有權之讓與',
      body: paragraphs(
        `${LESSOR}於租賃住宅交付後，${OPERATOR}或次承租人占有中，縱將其所有權讓與第三人，本契約對於受讓人仍繼續存在。`,
        `前項情形，${LESSOR}應移交押金及已預收之租金予受讓人，並以書面通知${OPERATOR}。`,
        '本契約如未經公證，其期限逾五年者，不適用第一項之規定。',
      ),
    },
    // 16
    {
      title: '出租人提前終止租約',
      body: paragraphs(
        `租賃期間有下列情形之一者，${LESSOR}得提前終止租約，${OPERATOR}不得要求任何賠償：`,
        items([
          `${LESSOR}為重新建築而必要收回。`,
          `${OPERATOR}遲付租金之總額達二個月之金額，經${LESSOR}定相當期限催告，仍不為支付。`,
          `${OPERATOR}積欠管理費或其他應負擔之費用達二個月之租金額，經${LESSOR}定相當期限催告，仍不為支付。`,
          `${OPERATOR}違反第七條第一項規定，擅自變更用途，經${LESSOR}阻止仍繼續為之。`,
          `${OPERATOR}違反第七條第二項規定，未經${LESSOR}同意，擅自將本租賃住宅以出借或轉租以外之其他方式供他人使用，經${LESSOR}阻止仍繼續為之。`,
          `${OPERATOR}毀損租賃住宅或附屬設備，經${LESSOR}定相當期限催告修繕仍不為修繕或相當之賠償。`,
          `${OPERATOR}違反第八條第一項規定，未履行修繕義務。`,
          `${OPERATOR}違反第九條第一項規定，未經${LESSOR}同意，擅自進行室內裝修，經${LESSOR}阻止仍繼續為之。`,
          `${OPERATOR}違反第九條第二項規定，未依相關法令規定進行室內裝修，經${LESSOR}阻止仍繼續為之。`,
          `${OPERATOR}違反第九條第二項規定，進行室內裝修，損害原有建築結構之安全。`,
          `${OPERATOR}轉租本租賃住宅，違反第十一條第一項第三款規定，逾${LESSOR}同意轉租之範圍或期間。`,
          `${OPERATOR}違反第十一條第一項第八款規定，將${LESSOR}同意轉租權利及其管理業務轉讓予第三人，經${LESSOR}阻止仍繼續為之。`,
          `${OPERATOR}經主管機關撤銷、廢止其許可或登記。`,
        ]),
        `${LESSOR}依前項規定提前終止租約者，應依下列規定期限，檢附相關事證，以書面通知${OPERATOR}：`,
        items([
          '依前項第一款規定終止者，於終止前三個月。',
          '依前項第二款至第十三款規定終止者，於終止前三十日。但前項第十款有危害公共安全或有第十三款之情形者，得不先期通知。',
        ]),
      ),
    },
    // 17
    {
      title: '包租業提前終止租約',
      body: paragraphs(
        `租賃期間有下列情形之一者，${OPERATOR}得提前終止租約之全部或一部：`,
        items([
          `租賃住宅或附屬設備損壞，應由${LESSOR}負擔修繕費用者，經${OPERATOR}定相當期限催告，${LESSOR}仍不於期限內支付。`,
          `租賃住宅因不可歸責於${OPERATOR}及次承租人之事由致一部滅失，且其存餘部分不能達租賃之目的。`,
          '租賃住宅有危及次承租人或其同居人之安全或健康之瑕疵。',
          '因第三人就租賃住宅主張其權利，致次承租人不能為約定之居住使用。',
        ]),
        `${OPERATOR}依前項各款規定提前終止租約者，應於終止前三十日，檢附相關事證，以書面通知${LESSOR}。但前項第三款情況危急者，得不先期通知。`,
      ),
    },
    // 18
    {
      title: '出租人提前終止租約之處理',
      body: paragraphs(
        `${OPERATOR}應於知悉${LESSOR}提前終止本契約之次日起五日內通知次承租人終止轉租契約，協調返還租賃住宅、執行屋況及附屬設備點交事務、退還向次承租人預收之租金及全部或一部押金或履行其他應盡事宜。`,
        `前項${LESSOR}提前終止本契約之情形，於${OPERATOR}因故停業、解散或他遷不明時，${LESSOR}得請求所在地租賃住宅服務商業同業公會或其全國聯合會協調返還租賃住宅，該同業公會或其全國聯合會不得拒絕。`,
        `前二項${LESSOR}提前終止本契約之情形，因可歸責於${OPERATOR}之事由，致${LESSOR}或次承租人受損害時，${OPERATOR}應負賠償責任。`,
      ),
    },
    // 19
    {
      title: '遺留物之處理',
      body: paragraphs(
        `本契約租期屆滿或提前終止租約，依第十四條完成點交或視為完成點交之手續後，${OPERATOR}或次承租人仍於租賃住宅有遺留物者，除租賃雙方另有約定外，經${LESSOR}定相當期限向${OPERATOR}催告，逾期仍不取回時，視為拋棄其所有權。`,
        `${LESSOR}處理前項遺留物所生費用，得由第四條第一項規定之押金中抵充，如有不足，並得向${OPERATOR}請求給付不足之費用。`,
      ),
    },
    // 20
    {
      title: '履行本契約之通知',
      body: paragraphs(
        '除本契約另有約定外，租賃雙方相互間之通知，以郵寄為之者，應以本契約所記載之地址為準；如因地址變更未告知他方，致通知無法到達時，以第一次郵遞之日期推定為到達日。',
        '前項之通知，租賃雙方約定得以本契約所記載之電子郵件信箱，以文字顯示方式為之。',
      ),
    },
    // 21
    {
      title: '其他約定',
      body: paragraphs(
        `本契約租賃雙方${choice(notarized, '同意', '不同意')}辦理公證。`,
        `本契約經辦理公證者，租賃雙方${choice(notarized, '同意', '不同意')}公證書載明下列事項應逕受強制執行：`,
        items([
          `${OPERATOR}如於租期屆滿後不返還租賃住宅。`,
          `${OPERATOR}未依約給付之欠繳租金、費用及${LESSOR}或租賃住宅所有權人代繳之管理費，或違約時應支付之金額。`,
          `${LESSOR}如於租期屆滿或本契約終止時，應返還${OPERATOR}之全部或一部押金。`,
        ]),
        '公證書載明金錢債務逕受強制執行時，如有保證人者，前項後段第（二）款之效力及於保證人。',
        `其他約定事項：${f.extra && f.extra.trim() ? f.extra.trim() : '無。'}`,
      ),
    },
    // 22
    {
      title: '契約及其相關附件效力',
      body: paragraphs(
        '本契約以電子文件方式作成，自租賃雙方完成電子簽署之日（簽約日）起生效，租賃雙方各自留存一份電子檔，效力與契約正本相同。',
        '本契約廣告及相關附件視為本契約之一部分。',
      ),
    },
    // 23
    {
      title: '當事人及相關人員基本資料',
      body: paragraphs(
        '本契約應記載當事人、租賃住宅管理人員及其基本資料如下：',
        items([
          partyContactLine(`${LESSOR}之`, { name: f.landlordName, email: f.landlordEmail }, t.partyA, false),
          partyContactLine(`${OPERATOR}之`, { name: f.tenantName, email: f.tenantEmail }, t.partyB, true),
          managerContactLine('租賃住宅管理人員之', t.manager),
        ]),
      ),
    },
  ];
}

/**
 * 條文：標題已含條號，並帶公告的點次。欄位進、條文出。
 * 沒有選用條款，也沒有範本以外的結尾條款：其他約定事項收在第二十一條，所以條號永遠與公告的點次相同。
 */
export function buildMasterLeaseNoticeClauses(fields: MasterLeaseContractFields): NoticeClause[] {
  return numberClauses(specs(fields), '應約定事項');
}

/** 與其他合約類型一致的入口，PDF 與確認頁用。 */
export function buildMasterLeaseClauses(fields: MasterLeaseContractFields): { title: string; body: string }[] {
  return buildMasterLeaseNoticeClauses(fields).map(({ title, body }) => ({ title, body }));
}

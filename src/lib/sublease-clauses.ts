// 住宅轉租契約的條文（MIL-199、ADR-0030 決議 6、P0-10）。
//
// 依內政部「住宅轉租定型化契約應記載及不得記載事項」撰寫。公告原文見
// docs/research/asset-mgmt-platform/legal-sources/sublease-notice-text.md
// （108 年 2 月 23 日內授中辦地字第 1080260690 號公告，113 年 11 月 21 日台內地字第 1130266382 號公告修正）。
// 條號與公告的點次一一對應：第 N 條就是應記載事項第 N 點，公告內「第 X 點」的引用改寫成「第 X 條」。
// 公告的選項（□…□…）存在 `fields.terms`，沒填的用 lease-family-terms.ts 的預設值，預設值待法務確認（MIL-62）。
//
// 不得記載事項十點不另成條文，而是用測試守住：條文不得含這十種記載，並且正面寫出相反的記載（見測試）。
// 審閱期：公告要求審閱期間至少三日，第一條寫明承租人的審閱權利。系統不強制審閱期（MIL-199 決議 8），待法務確認。
// 附件：現況確認書是附件一，內容存在 `fields.statusAnnex`，PDF 排在簽署欄之後。公告附件二（同意轉租範圍）與
// 附件三（修繕項目及範圍）收在第十一條的條文裡，不另做表單頁。
// 範本 v1 是未經法務審閱的版本（legalReviewed=false），正式金鑰下無法送簽。
//
// 當事人稱謂照公告原文：包租業與承租人，包租契約的出租人稱原出租人。文件上不印「甲方」「乙方」（ADR-0030 決議 7）。
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
import type { SubleaseContractFields } from './types';

const LABELS = partyLabels('sublease');
const OPERATOR = LABELS.partyA; // 包租業
const LESSEE = LABELS.partyB; // 承租人
const ORIGINAL_LESSOR = '原出租人';

/** 公告「應記載事項」的二十四點，點次與標題照公告原文。涵蓋測試用它核對條文。 */
export const SUBLEASE_RECORDED_POINTS: readonly NoticePoint[] = [
  { point: 1, title: '契約審閱期' },
  { point: 2, title: '租賃標的' },
  { point: 3, title: '租賃期間' },
  { point: 4, title: '租金約定及支付' },
  { point: 5, title: '押金約定及返還' },
  { point: 6, title: '租賃期間相關費用之支付' },
  { point: 7, title: '稅費負擔之約定' },
  { point: 8, title: '使用租賃住宅之限制' },
  { point: 9, title: '修繕' },
  { point: 10, title: '室內裝修' },
  { point: 11, title: '包租業之義務及責任' },
  { point: 12, title: '承租人之義務及責任' },
  { point: 13, title: '租賃住宅部分滅失' },
  { point: 14, title: '提前終止租約之約定' },
  { point: 15, title: '租賃住宅之返還' },
  { point: 16, title: '租賃住宅所有權之讓與' },
  { point: 17, title: '包租業提前終止租約' },
  { point: 18, title: '承租人提前終止租約' },
  { point: 19, title: '提前終止包租契約之處理' },
  { point: 20, title: '遺留物之處理' },
  { point: 21, title: '履行本契約之通知' },
  { point: 22, title: '其他約定' },
  { point: 23, title: '契約及其相關附件效力' },
  { point: 24, title: '當事人及相關人員基本資料' },
];

/** 公告「不得記載事項」的十點，點次與內容照公告原文（113 年 11 月 21 日修正後）。反向測試用它列出每一點。 */
export const SUBLEASE_PROHIBITED_POINTS: readonly NoticePoint[] = [
  { point: 1, title: '不得約定拋棄審閱期間' },
  { point: 2, title: '不得約定廣告僅供參考' },
  { point: 3, title: '不得約定承租人不得申報租賃費用支出' },
  { point: 4, title: '不得約定承租人不得遷入戶籍' },
  { point: 5, title: '不得約定應由包租業或租賃住宅所有權人負擔之稅賦，若較出租前增加時，其增加部分由承租人負擔' },
  { point: 6, title: '不得約定免除或限制民法上包租業故意不告知之瑕疵擔保責任' },
  { point: 7, title: '不得約定承租人須繳回契約書' },
  { point: 8, title: '不得約定本契約之通知僅以電話方式為之' },
  { point: 9, title: '不得約定違反強制或禁止規定' },
  { point: 10, title: '不得約定承租人不得申請租金補貼' },
];

function dateRange(start: string, end: string): string {
  return `自 ${fmtDate(start)}起至 ${fmtDate(end)}止`;
}

function choice(allowed: boolean, yes: string, no: string): string {
  return allowed ? yes : no;
}

function masterLeaseTermText(f: SubleaseContractFields): string {
  if (f.masterLeaseStart && f.masterLeaseEnd) {
    return `（包租契約之租賃期間${dateRange(f.masterLeaseStart, f.masterLeaseEnd)}）`;
  }
  return '';
}

function specs(f: SubleaseContractFields): ClauseSpec[] {
  const t: ResolvedLeaseFamilyTerms = resolveLeaseFamilyTerms(f.terms);
  const scopeText = t.scope === 'whole' ? '全部' : `一部：${blank(t.scopeNote)}`;
  const notarized = t.notarization === 'agreed';

  return [
    // 1
    {
      title: '契約審閱期',
      body: paragraphs(
        `住宅轉租契約（以下簡稱本契約）於${LESSEE}簽署前，${LESSEE}得攜回審閱，契約審閱期間至少三日。`,
        `${OPERATOR}不得要求${LESSEE}拋棄審閱期間。`,
      ),
    },
    // 2
    {
      title: '租賃標的',
      body: items([
        `租賃住宅標示：${propertyMarkText(f)}。土地與建物登記資料（基地坐落、建號、權利範圍、面積）、車位、有無設定他項權利、有無查封登記：${blank(t.titleNote)}。`,
        `租賃範圍：租賃住宅${scopeText}。`,
        `租賃附屬設備：${equipmentText(f)}租賃標的之現況，詳如後附租賃標的現況確認書（附件一）。`,
      ]),
    },
    // 3
    {
      title: '租賃期間',
      body: `租賃期間${dateRange(f.startDate, f.endDate)}。租賃期間不得少於三十日，並不得逾包租契約之租賃期間${masterLeaseTermText(f)}。`,
    },
    // 4
    {
      title: '租金約定及支付',
      body: paragraphs(
        `${LESSEE}每月租金為${fmtMoney(f.rent)}，每期應繳納一個月租金，並於每月 ${
          f.payDay != null ? f.payDay : '＿＿'
        } 日前支付，不得藉任何理由拖延或拒絕；${OPERATOR}於租賃期間亦不得藉任何理由要求調漲租金。`,
        `租金支付方式：${rentPaymentText(t)}`,
      ),
    },
    // 5
    {
      title: '押金約定及返還',
      body: paragraphs(
        `押金由租賃雙方約定為 ${depositMonthsText(f.rent, f.deposit)} 個月租金，金額為${fmtMoney(
          f.deposit,
        )}（最高不得超過二個月租金之總額）。${LESSEE}應於簽訂本契約之同時給付${OPERATOR}。`,
        `前項押金，除有第十四條第三項、第十五條第四項及第二十條第二項得抵充之情形外，${OPERATOR}應於租期屆滿或租賃契約終止，${LESSEE}返還租賃住宅時，返還押金或抵充本契約所生債務後之賸餘押金。`,
      ),
    },
    // 6
    {
      title: '租賃期間相關費用之支付',
      body: paragraphs(
        '租賃期間，使用租賃住宅所生之相關費用：',
        items(feeLines(t, { partyA: OPERATOR, partyB: LESSEE }, { tenantBearsLimits: true })),
      ),
    },
    // 7
    {
      title: '稅費負擔之約定',
      body: paragraphs(
        '本契約有關稅費，依下列約定辦理：',
        items([
          `${OPERATOR}收取現金者，其銀錢收據應貼用之印花稅票，由${OPERATOR}負擔。`,
          `依營業稅法規定應開立發票報繳之營業稅，由${OPERATOR}負擔。`,
          '其他稅費及其支付方式：依相關法令規定辦理，法令未規定者由租賃雙方另行約定。',
        ]),
        '本契約租賃雙方同意辦理公證者，其有關費用依下列約定辦理：',
        items(['公證費，由租賃雙方平均負擔。', '公證代辦費，由租賃雙方平均負擔。']),
      ),
    },
    // 8
    {
      title: '使用租賃住宅之限制',
      body: paragraphs(
        `本租賃住宅係供居住使用，${LESSEE}不得變更用途。`,
        `${LESSEE}同意遵守公寓大廈規約或其他住戶應遵行事項，不得違法使用、存放有爆炸性或易燃性物品，影響公共安全、公共衛生或居住安寧。`,
        `${LESSEE}不得將本租賃住宅之全部或一部分轉租，或將租賃權轉讓於他人。`,
      ),
    },
    // 9
    {
      title: '修繕',
      body: paragraphs(
        `租賃住宅或附屬設備損壞時，應由${OPERATOR}負責修繕。但其損壞係可歸責於${LESSEE}之事由者，不在此限。`,
        `前項由${OPERATOR}負責修繕者，${LESSEE}得定相當期限催告修繕，如${OPERATOR}未於${LESSEE}所定相當期限內修繕時，${LESSEE}得自行修繕，並請求${OPERATOR}償還其費用或於第四條約定之租金中扣除。`,
        `${OPERATOR}為修繕租賃住宅所為之必要行為，應於相當期間先期通知，${LESSEE}無正當理由不得拒絕。`,
        `前項${OPERATOR}於修繕期間，致租賃住宅全部或一部不能居住使用者，${LESSEE}得請求${OPERATOR}扣除該期間全部或一部之租金。`,
      ),
    },
    // 10
    {
      title: '室內裝修',
      body: paragraphs(
        `${LESSEE}有室內裝修之需要，應經${OPERATOR}同意並依相關法令規定辦理，且不得損害原有建築結構之安全。`,
        `${LESSEE}經${OPERATOR}同意裝修者，其裝修增設部分若有損壞，由${LESSEE}負責修繕。`,
        `第一項情形，${LESSEE}返還租賃住宅時，${choice(t.restoreOnReturn === 'restore', '應負責回復原狀', '現況返還')}。`,
      ),
    },
    // 11
    {
      title: '包租業之義務及責任',
      body: paragraphs(
        `本契約租賃期間，${OPERATOR}之義務及責任如下：`,
        items([
          `應出示租賃住宅服務業登記證影本，供${LESSEE}核對。`,
          `應向${LESSEE}提供包租契約之出租人（以下簡稱${ORIGINAL_LESSOR}）同意轉租之書面文件，並載明其與${ORIGINAL_LESSOR}之租賃標的範圍、租賃期間及得終止住宅包租契約之事由。`,
          `應以合於所約定居住使用之租賃住宅，交付${LESSEE}，並於租賃期間保持其合於居住使用之狀態。`,
          `簽訂本契約，應先向${LESSEE}說明租賃住宅由${OPERATOR}負責修繕項目及範圍，並提供有修繕必要時之聯絡方式。`,
          `應製作租賃標的現況確認書（如附件一），並於簽訂本契約時，以該確認書及本契約向${LESSEE}解說。`,
          `應於收受${LESSEE}之有關費用或文件時，開立統一發票或掣給收據。`,
          `應執行日常修繕維護並製作紀錄，提供${LESSEE}查詢或取閱。`,
          `${ORIGINAL_LESSOR}有修繕之必要行為時，${OPERATOR}應於相當期間先期通知${LESSEE}配合辦理。`,
          `應配合${LESSEE}設立戶籍需要，協助向${ORIGINAL_LESSOR}取得可供設籍之相關證明。`,
          `依第六條規定約定電費由${LESSEE}負擔者，${OPERATOR}應提供${LESSEE}租賃標的之電費資訊。${LESSEE}亦得逕向台灣電力股份有限公司申辦查詢租賃期間之有關電費資訊。`,
        ]),
        `前項第二款、第四款之同意轉租及負責修繕項目、範圍如下。${ORIGINAL_LESSOR}同意轉租範圍：租賃住宅${scopeText}。${ORIGINAL_LESSOR}同意轉租期間與終止包租契約之事由：以${OPERATOR}提供之同意轉租書面文件所載為準${masterLeaseTermText(f)}。${OPERATOR}負責修繕項目及範圍：${blank(t.repairScopeNote)}。未經約定確認之設備或設施，除其損壞係可歸責於${LESSEE}之事由外，由${OPERATOR}負責修繕。`,
      ),
    },
    // 12
    {
      title: '承租人之義務及責任',
      body: paragraphs(
        `${LESSEE}應於簽訂本契約時，出示國民身分證或其他足資證明身分之文件，供${OPERATOR}核對。`,
        `${LESSEE}應以善良管理人之注意，保管、使用租賃住宅。`,
        `${LESSEE}違反前項義務，致租賃住宅毀損或滅失者，應負損害賠償責任。但依約定之方法或依租賃住宅之性質使用，致有變更或毀損者，不在此限。`,
      ),
    },
    // 13
    {
      title: '租賃住宅部分滅失',
      body: `租賃關係存續中，因不可歸責於${LESSEE}之事由，致租賃住宅之一部滅失者，${LESSEE}得按滅失之部分，請求減少租金。`,
    },
    // 14
    {
      title: '提前終止租約之約定',
      body: paragraphs(
        `本契約於期限屆滿前，除第十七條及第十八條規定外，租賃雙方${choice(t.earlyTermination === 'allowed', '得', '不得')}終止租約。`,
        '依約定得終止租約者，租賃之一方應至少於終止前一個月通知他方。一方未為先期通知而逕行終止租約者，應賠償他方最高不得超過一個月租金額之違約金。',
        `前項${LESSEE}應賠償之違約金得由第五條第一項規定之押金中抵充。`,
        `租期屆滿前，依第二項規定終止租約者，${OPERATOR}已預收之租金應返還予${LESSEE}。`,
      ),
    },
    // 15
    {
      title: '租賃住宅之返還',
      body: paragraphs(
        `租期屆滿或租賃契約終止時，${OPERATOR}應即結算${LESSEE}第六條約定之相關費用，並會同${LESSEE}共同完成屋況及附屬設備之點交手續，${LESSEE}應將租賃住宅返還${OPERATOR}並遷出戶籍或其他登記。`,
        '前項租賃之一方未會同點交，經他方定相當期限催告仍不會同者，視為完成點交。',
        `${LESSEE}未依第一項規定返還租賃住宅時，${OPERATOR}應明示不以不定期限繼續契約，並得向${LESSEE}請求未返還租賃住宅期間之相當月租金額，及相當月租金額計算之違約金（未足一個月者，以日租金折算）至返還為止。`,
        `前項金額及${LESSEE}未繳清第六條約定之相關費用，${OPERATOR}得由第五條第一項規定之押金中抵充。`,
      ),
    },
    // 16
    {
      title: '租賃住宅所有權之讓與',
      body: paragraphs(
        `本契約租賃期間，租賃住宅所有權人縱將其所有權讓與第三人，包租契約對於受讓人仍繼續存在，本契約不因此而受影響。`,
        `前項情形，${OPERATOR}應於接獲${ORIGINAL_LESSOR}通知後，以書面通知${LESSEE}。`,
      ),
    },
    // 17
    {
      title: '包租業提前終止租約',
      body: paragraphs(
        `租賃期間有下列情形之一者，${OPERATOR}得提前終止租約，${LESSEE}不得要求任何賠償：`,
        items([
          `${ORIGINAL_LESSOR}為重新建築而必要收回。`,
          `${LESSEE}遲付租金之總額達二個月之金額，經${OPERATOR}定相當期限催告，仍不為支付。`,
          `${LESSEE}積欠管理費或其他應負擔之費用達二個月之租金額，經${OPERATOR}定相當期限催告，仍不為支付。`,
          `${LESSEE}違反第八條第一項規定，擅自變更用途，經${OPERATOR}阻止仍繼續為之。`,
          `${LESSEE}違反第八條第二項規定，違法使用、存放有爆炸性或易燃性物品，經${OPERATOR}阻止仍繼續為之。`,
          `${LESSEE}違反第八條第三項規定，擅自將租賃住宅轉租或轉讓租賃權予他人，經${OPERATOR}阻止仍未終止轉租或轉讓契約。`,
          `${LESSEE}毀損租賃住宅或附屬設備，經${OPERATOR}定相當期限催告修繕仍不為修繕或相當之賠償。`,
          `${LESSEE}違反第十條第一項規定，未經${OPERATOR}同意，擅自進行室內裝修，經${OPERATOR}阻止仍繼續為之。`,
          `${LESSEE}違反第十條第一項規定，未依相關法令規定進行室內裝修，經${OPERATOR}阻止仍繼續為之。`,
          `${LESSEE}違反第十條第一項規定，進行室內裝修，損害原有建築結構之安全。`,
        ]),
        `${OPERATOR}依前項規定提前終止租約者，應依下列規定期限，檢附相關事證，以書面通知${LESSEE}：`,
        items([
          '依前項第一款規定終止者，於終止前三個月。',
          '依前項第二款至第十款規定終止者，於終止前三十日。但前項第五款及第十款有公共安全之危害情形者，得不先期通知。',
        ]),
      ),
    },
    // 18
    {
      title: '承租人提前終止租約',
      body: paragraphs(
        `租賃期間有下列情形之一，${LESSEE}得提前終止租約，${OPERATOR}不得要求任何賠償：`,
        items([
          `租賃住宅未合於居住使用，並有修繕之必要，經${LESSEE}依第九條第二項規定催告，仍不於期限內修繕。`,
          `租賃住宅因不可歸責於${LESSEE}之事由致一部滅失，且其存餘部分不能達租賃之目的。`,
          `租賃住宅有危及${LESSEE}或其同居人之安全或健康之瑕疵；${LESSEE}於簽約時已明知該瑕疵或拋棄終止租約權利者，亦同。`,
          `${LESSEE}因疾病、意外產生有長期療養之需要。`,
          `因第三人就租賃住宅主張其權利，致${LESSEE}不能為約定之居住使用。`,
          `${OPERATOR}經主管機關撤銷、廢止其許可或登記。`,
        ]),
        `${LESSEE}依前項各款規定提前終止租約者，應於終止前三十日，檢附相關事證，以書面通知${OPERATOR}。但前項第三款前段其情況危急或有第六款之情形者，得不先期通知。`,
        `${LESSEE}死亡，其繼承人得主張終止租約，其通知期限及方式，準用前項規定。`,
      ),
    },
    // 19
    {
      title: '提前終止包租契約之處理',
      body: paragraphs(
        `${OPERATOR}應於知悉${ORIGINAL_LESSOR}提前終止包租契約之次日起五日內通知${LESSEE}終止本契約，協調返還租賃住宅、執行屋況及附屬設備點交事務、退還預收租金及全部或一部押金，並協助${LESSEE}優先承租其他租賃住宅。`,
        `前項${ORIGINAL_LESSOR}提前終止包租契約之情形，於${OPERATOR}因故停業、解散或他遷不明時，得由${ORIGINAL_LESSOR}通知${LESSEE}，${LESSEE}並得請求所在地租賃住宅服務商業同業公會或其全國聯合會協調續租事宜，該同業公會或其全國聯合會不得拒絕。`,
        `前二項${ORIGINAL_LESSOR}提前終止包租契約之情形，因可歸責於${OPERATOR}之事由，致${LESSEE}受損害時，${OPERATOR}應負賠償責任。`,
      ),
    },
    // 20
    {
      title: '遺留物之處理',
      body: paragraphs(
        `本契約租期屆滿或提前終止租約，依第十五條完成點交或視為完成點交之手續後，${LESSEE}仍於租賃住宅有遺留物者，除租賃雙方另有約定外，經${OPERATOR}定相當期限向${LESSEE}催告，逾期仍不取回時，視為拋棄其所有權。`,
        `${OPERATOR}處理前項遺留物所生費用，得由第五條第一項規定之押金中抵充，如有不足，並得向${LESSEE}請求給付不足之費用。`,
      ),
    },
    // 21
    {
      title: '履行本契約之通知',
      body: paragraphs(
        '除本契約另有約定外，租賃雙方相互間之通知，以郵寄為之者，應以本契約所記載之地址為準；如因地址變更未告知他方，致通知無法到達時，以第一次郵遞之日期推定為到達日。',
        '前項之通知，租賃雙方約定得以本契約所記載之電子郵件信箱，以文字顯示方式為之。',
      ),
    },
    // 22
    {
      title: '其他約定',
      body: paragraphs(
        `本契約租賃雙方${choice(notarized, '同意', '不同意')}辦理公證。`,
        `本契約經辦理公證者，租賃雙方${choice(notarized, '同意', '不同意')}公證書載明下列事項應逕受強制執行：`,
        items([
          `${LESSEE}如於租期屆滿後不返還租賃住宅。`,
          `${LESSEE}未依約給付之欠繳租金、費用及${OPERATOR}或租賃住宅所有權人代繳之管理費，或違約時應支付之金額。`,
          `${OPERATOR}如於租期屆滿或本契約終止時，應返還${LESSEE}之全部或一部押金。`,
        ]),
        '公證書載明金錢債務逕受強制執行時，如有保證人者，前項後段第（二）款之效力及於保證人。',
        `本契約之約定，不影響${LESSEE}依法申報租賃費用支出及申請租金補貼之權利。`,
        `其他約定事項：${f.extra && f.extra.trim() ? f.extra.trim() : '無。'}`,
      ),
    },
    // 23
    {
      title: '契約及其相關附件效力',
      body: paragraphs(
        '本契約以電子文件方式作成，自租賃雙方完成電子簽署之日（簽約日）起生效，租賃雙方各自留存一份電子檔，效力與契約正本相同。',
        `${OPERATOR}之廣告及相關附件視為本契約之一部分。`,
      ),
    },
    // 24
    {
      title: '當事人及相關人員基本資料',
      body: paragraphs(
        '本契約應記載當事人、租賃住宅管理人員及其基本資料如下：',
        items([
          partyContactLine(`${LESSEE}之`, { name: f.tenantName, email: f.tenantEmail }, t.partyB, false),
          partyContactLine(`${OPERATOR}之`, { name: f.landlordName, email: f.landlordEmail }, t.partyA, true),
          managerContactLine('租賃住宅管理人員之', t.manager),
        ]),
      ),
    },
  ];
}

/**
 * 條文：標題已含條號，並帶公告的點次。欄位進、條文出。
 * 沒有選用條款，也沒有範本以外的結尾條款：其他約定事項收在第二十二條，所以條號永遠與公告的點次相同。
 */
export function buildSubleaseNoticeClauses(fields: SubleaseContractFields): NoticeClause[] {
  return numberClauses(specs(fields), '應記載事項');
}

/** 與其他合約類型一致的入口，PDF 與確認頁用。 */
export function buildSubleaseClauses(fields: SubleaseContractFields): { title: string; body: string }[] {
  return buildSubleaseNoticeClauses(fields).map(({ title, body }) => ({ title, body }));
}

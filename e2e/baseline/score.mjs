// 現況基準（MIL-170）的評分。速度、導覽、視覺由量測與靜態統計依規則算出，一致、狀態、回饋由評分者看截圖與原始碼後手填。
// 用法（在 worktree 根目錄）：node e2e/baseline/score.mjs，輸出 docs/ui/baseline/data/scores.json。
// 規則見 docs/ui/baseline/README.md 的「評分」一節。重跑量測後要重新看截圖，更新下面的手填表。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PAGES } from './pages.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
// BASELINE_UI_DIR 改輸出位置：最終驗收（MIL-185）設成 docs/ui/final，並讀 e2e/baseline/score-final.mjs 的手填表
const DATA = path.join(ROOT, process.env.BASELINE_UI_DIR ?? path.join('docs', 'ui', 'baseline'), 'data');
const results = JSON.parse(readFileSync(path.join(DATA, 'results.json'), 'utf8'));
const stats = JSON.parse(readFileSync(path.join(DATA, 'static-stats.json'), 'utf8'));
const byId = new Map(results.pages.map((p) => [p.id, p]));

// ---------------------------------------------------------------------------
// 手填：一致、狀態、回饋，各一個 [分數, 理由]。manual 是 detect 抓不到、評分者看截圖後補記的 P0 與 P1。
// back：詳情頁有返回列表的路徑（頁面上看得到的連結，量測腳本的字串比對抓不全，所以人工確認）。
// defect：截圖上看得到的版面缺陷，視覺扣 1 分。
// 最終驗收（BASELINE_UI_DIR 有設）改讀 e2e/baseline/score-final-manual.mjs 的手填表
const MANUAL = process.env.BASELINE_UI_DIR ? (await import('./score-final-manual.mjs')).MANUAL : {
  '01-workbench': {
    c: [2, '四張數字卡加待辦與快捷入口，只有這頁用這個版型，標題與別頁的頁首不同'],
    st: [2, '待辦只列草稿，狀態標籤與合約列表同色，但沒有寫出下一步由誰處理'],
    fb: [1, '唯讀頁，沒有載入失敗的畫面，也沒有任何回饋呼叫'],
  },
  '02-contracts-list': {
    c: [2, '標題、篩選、表格的列表結構，與物件列表、收款帳戶大致相同，篩選列放在標題右側'],
    st: [3, '狀態欄用標籤：待乙方簽藍、已拒簽紅、已完成綠，但名稱與案件列表的「簽署中」不同'],
    fb: [2, '撤回與複製有確認與訊息，列表載入失敗沒有處理'],
    defect: '操作欄被截在右邊，要橫向捲動才按得到「撤回」「繼續編輯」',
    manual: [{ p: 'P1', text: '1440 寬時表格超出內容區，最右欄的操作按鈕被截掉，主要動作要橫向捲動才找得到' }],
  },
  '03-contract-detail-signing': {
    c: [2, '頁首、步驟條、分頁加兩欄內容，是合約專用版型，與案件詳情、物件詳情不同'],
    st: [3, '頁首有狀態標籤與三步進度，並寫出「目前待簽：乙方 王租客」，但顏色與列表不共用定義'],
    fb: [3, '撤回、取得連結、模擬事件都有訊息與確認，錯誤沒有寫下一步'],
    back: false,
    manual: [{ p: 'P1', text: '詳情頁沒有返回合約列表的連結，只能靠側欄或瀏覽器上一頁' }],
  },
  '04-contract-detail-completed': {
    c: [2, '與簽署中的詳情同一版型，主要動作換成下載與複製'],
    st: [2, '標籤顯示已完成，頁首沒有寫出後續（案件、帳務）的下一步'],
    fb: [3, '下載與複製有訊息，錯誤沒有寫下一步'],
    back: false,
    manual: [{ p: 'P1', text: '詳情頁沒有返回合約列表的連結' }],
  },
  '05-contract-detail-draft': {
    c: [2, '與簽署中的詳情同一版型，草稿多一個提示卡'],
    st: [3, '草稿標籤加提示「請按右上繼續編輯」，下一步寫在內容區，不在頁首'],
    fb: [3, '複製與刪除有確認與訊息，錯誤沒有寫下一步'],
    back: false,
    manual: [{ p: 'P1', text: '詳情頁沒有返回合約列表的連結' }],
  },
  '06-contract-detail-declined': {
    c: [2, '與簽署中的詳情同一版型'],
    st: [2, '標籤顯示已拒簽（紅），但沒有寫出誰拒簽、下一步怎麼重新送簽'],
    fb: [3, '複製有訊息，錯誤沒有寫下一步'],
    back: false,
    manual: [{ p: 'P1', text: '詳情頁沒有返回合約列表的連結；拒簽後的處理動作不明確（MIL-167 使用者故事 26）' }],
  },
  '07-wizard-1-property': {
    c: [2, '步驟條在標題下方，內容卡片只佔左側約 2/3，右側留空；與合約詳情的兩欄不同'],
    st: [2, '簽署序列以標籤列出，沒有狀態概念；提示用兩種不同樣式的藍色提示框'],
    fb: [3, '欄位錯誤與提示都有，送出前檢查會列出原因'],
    back: false,
  },
  '08-wizard-2-fields': {
    c: [2, '與其他精靈步驟同一結構，按鈕在表單下方，位置隨表單高度移動'],
    st: [2, '步驟條標出目前與已完成步驟，欄位必填以紅星標示'],
    fb: [3, '欄位錯誤顯示在欄位旁，草稿自動保存有提示'],
    back: false,
  },
  '09-wizard-3-signature': {
    c: [2, '與其他精靈步驟同一結構，預覽與簽署區檢核分兩欄'],
    st: [3, '右欄的簽署區檢核用綠色勾與標籤顯示甲乙方是否放好'],
    fb: [3, '放置、刪除簽名框有檢核即時更新，缺少時有提示'],
    back: false,
  },
  '10-wizard-4-confirm': {
    c: [2, '與其他精靈步驟同一結構，確認頁用表格摘要，與合約詳情的摘要卡片不同'],
    st: [3, '最上方寫出「乙方先簽」的簽署順序，確認後送出'],
    fb: [3, '送簽失敗會列出全部原因，成功後導向詳情頁'],
    back: false,
  },
  '11-properties-list': {
    c: [2, '標題加右側主要按鈕加表格，與合約列表近似，但沒有篩選列'],
    st: [2, '產權欄用橘色「待驗證」標籤，名稱與其他頁的待驗證不同色'],
    fb: [3, '新增、編輯、封存有訊息與確認'],
    defect: '操作欄被截在右邊，要橫向捲動才按得到',
    manual: [{ p: 'P1', text: '1440 寬時表格超出內容區，最右欄的操作按鈕被截掉' }],
  },
  '12-property-detail': {
    c: [2, '返回連結、標題、分頁、描述表，與案件詳情近似，與合約詳情不同'],
    st: [2, '沒有狀態標籤，產權狀態在別的分頁'],
    fb: [3, '儲存與新增分租單位有訊息'],
    back: true,
  },
  '13-cases-list': {
    c: [2, '分頁籤加表格，與合約列表同一族，但沒有標題列的主要按鈕'],
    st: [2, '案件狀態用標籤，「目前合約」欄卻是純文字，同一個合約狀態在這裡沒有顏色'],
    fb: [1, '唯讀列表，沒有載入失敗的畫面'],
    manual: [{ p: 'P1', text: '「目前合約」欄的合約狀態是純文字，與合約列表的有色標籤不同（MIL-167 使用者故事 2）' }],
  },
  '14-case-detail-overview': {
    c: [2, '標題旁有狀態與返回連結、分頁，與物件詳情近似'],
    st: [3, '頁首有案件狀態標籤，概況表寫出狀態與主辦'],
    fb: [2, '唯讀概況，成員與合約分頁有操作訊息'],
    back: true,
  },
  '15-case-detail-ledger': {
    c: [2, '分頁內縱向堆疊五個區塊，標題層級與其他詳情頁的描述表不同'],
    st: [3, '押金台帳顯示狀態與餘額，應收期別顯示「生效」，詞彙與合約狀態不同'],
    fb: [3, '登錄與儲存有成功訊息（驗收時確認），錯誤沒有寫下一步'],
    back: true,
  },
  '16-payment-accounts': {
    c: [2, '標題加說明加右側按鈕加表格，與合約列表近似'],
    st: [3, '使用中綠色標籤、現金收取藍色標籤，持有人角色用灰色標籤'],
    fb: [3, '新增、編輯、停用有確認與訊息'],
  },
  '17-notifications': {
    c: [1, '內容只佔左側 800px，與其他列表滿版不同，用卡片加清單而不是表格'],
    st: [1, '沒有通知時只顯示空狀態，未讀以圓點與粗體標示，沒有狀態標籤'],
    fb: [2, '標已讀有訊息，載入失敗顯示整頁錯誤'],
  },
  '18-members': {
    c: [1, '三段縱向表單與表格，沒有頁首區，標題在頂部列'],
    st: [2, '角色用標籤，邀請狀態沒有標籤'],
    fb: [3, '邀請、改角色、移除有訊息與確認'],
    manual: [{ p: 'P2', text: '側欄沒有標出目前位置，成員管理不在選單內' }],
  },
  '19-owner-overview': {
    c: [2, '屋主端頂部選單殼層，內容為卡片，與後台殼層不同'],
    st: [1, '空狀態（資料來自假資料 adapter，真實帳號沒有資料），沒有狀態呈現可評'],
    fb: [1, '唯讀頁，只有空狀態說明'],
  },
  '20-owner-handovers': {
    c: [2, '兩張卡片各含一張表，與後台的移交清單結構不同'],
    st: [1, '兩個區塊都是空狀態（資料來自假資料 adapter），無法評狀態呈現'],
    fb: [2, '空狀態有說明，沒有其他操作'],
  },
  '21-owner-handover-new': {
    c: [2, '返回連結、標題、說明、卡片、按鈕，結構接近發起類表單'],
    st: [1, '空狀態，無委託中的案件，「產生草稿」按鈕停用'],
    fb: [2, '空狀態說明原因，停用按鈕沒有說明如何啟用'],
    back: true,
  },
  '22-owner-handover-detail': {
    note: '沒有畫面。移交資料在假資料 adapter，真實登入的帳號讀不到任何移交，這頁無法從畫面進入。評分用原始碼推估，不列入平均。',
  },
  '23-owner-case-detail': {
    c: [2, '與後台的案件詳情同一元件，殼層換成屋主端頂部選單'],
    st: [3, '頁首有案件狀態與「唯讀」標籤'],
    fb: [2, '唯讀版本，沒有編輯操作'],
    back: true,
    manual: [{ p: 'P2', text: '頂部選單沒有標出目前位置（案件詳情不在選單內）' }],
  },
  '24-org-handovers': {
    c: [2, '摘要句加兩張卡片各含一張表，與屋主端的移交清單同一做法'],
    st: [3, '狀態標籤有等待（藍）、交出側已生效（橘）、已完成（綠），兩側完成度用圖示，但名稱與合約狀態不共用'],
    fb: [1, '唯讀清單，沒有載入失敗的畫面'],
    back: false,
  },
  '25-org-handover-detail': {
    c: [2, '移交詳情用卡片與提示，與合約詳情不同'],
    st: [2, '有狀態標籤與接手條件提示，沒有寫出下一步由誰處理'],
    fb: [3, '接手、確認有訊息'],
  },
  '26-practice': {
    c: [1, '縱向堆疊的資料區塊，沒有頁首與主要按鈕區'],
    st: [2, '「驗證狀態」與「進度」兩欄都顯示已驗證，一個灰色、一個綠色，同一狀態兩種顏色'],
    fb: [2, '送件有訊息，錯誤沒有寫下一步'],
    defect: '任職表的操作欄被截在右邊',
    manual: [{ p: 'P1', text: '業別表的「驗證狀態」與「進度」兩欄重複顯示已驗證，且顏色不同；任職表最右欄的「結束任職」被截掉' }],
  },
  '27-practitioner': {
    c: [1, '縱向堆疊的資料區塊，與執業主體頁相同做法，與列表、詳情版型都不同'],
    st: [3, '證書與任職顯示已驗證、待驗證、需要補件，並寫出「證書資料已核對」與核對日'],
    fb: [3, '個資告知、登錄、結束任職有訊息；阻擋時顯示固定訊息'],
  },
  '28-desk-queue': {
    c: [2, '標題加切換加表格，與其他列表近似'],
    st: [2, '類型以文字顯示，沒有狀態標籤，等待時間以文字顯示'],
    fb: [1, '唯讀佇列，沒有載入失敗的畫面'],
    manual: [{ p: 'P1', text: '平台營運者的側欄出現「建立合約」「物件」「案件」「合約」「收款帳戶」「移交」，營運者沒有這些頁面的用途，會誤點' }],
  },
  '29-desk-item-license': {
    c: [2, '返回連結加標題加描述加表單，結構與其他詳情不同'],
    st: [2, '驗證狀態顯示「待驗證」文字，沒有標籤'],
    fb: [3, '登錄核對結果有成功與錯誤訊息，422 會列出缺少的營業項目'],
    back: true,
  },
  '30-desk-item-credential': {
    c: [2, '與業別核對同一版型'],
    st: [2, '驗證狀態顯示文字，沒有標籤'],
    fb: [3, '登錄核對結果有成功與錯誤訊息'],
    back: true,
  },
  '31-login': {
    c: [2, '置中卡片，與後台殼層完全不同的外觀（沒有殼層）'],
    st: [2, '沒有狀態概念，錯誤以提示框顯示'],
    fb: [3, '驗證碼寄出、錯誤、重寄倒數都有提示，錯誤訊息一律相同以避免洩漏'],
    nav: 3,
    navNote: '單頁流程，沒有導覽需求，給 3 分',
  },
  '32-onboarding': {
    c: [2, '同登入頁的置中卡片'],
    st: [2, '沒有狀態概念，兩個身分選項以卡片按鈕呈現'],
    fb: [3, '送出結果一律顯示已送出，錯誤顯示在欄位旁'],
    nav: 3,
    navNote: '單頁流程，有「登出並改用其他 email」，沒有導覽需求，給 3 分',
  },
  '33-master-lease-detail': {
    c: [2, '與兩方合約的詳情同一版型'],
    st: [3, '三步進度加「目前待簽」寫出當前簽署人'],
    fb: [3, '撤回與模擬事件有訊息與確認'],
    back: false,
    manual: [{ p: 'P1', text: '詳情頁沒有返回合約列表的連結' }],
  },
  '34-master-lease-wizard-fields': {
    c: [2, '與其他精靈步驟同一結構，附件表格加指派面板，欄位多，頁面很長'],
    st: [2, '附件每列有狀態下拉，未填顯示「未填」，沒有彙總'],
    fb: [3, '送簽前檢查列出全部缺少的項目，欄位錯誤顯示在欄位旁'],
    back: false,
  },
  '35-design': {
    c: [1, '內部工具頁，用卡片堆疊展示 token，與其他頁無關'],
    st: [2, '展示了 5 種狀態標籤，但顏色寫在展示頁自己的程式碼'],
    fb: [1, '唯讀展示頁，沒有操作'],
    note: '內部工具頁，階段 1 會重做成設計展示頁，列入基準但不計入使用者頁面。',
  },
};

// ---------------------------------------------------------------------------
// 自動：速度、導覽、視覺

function speed(id) {
  const r = byId.get(id);
  const l = r?.load;
  if (!l) return null;
  const ms = l.msToStable;
  const seconds = ms === null ? '未穩定' : `${(ms / 1000).toFixed(1)} 秒`;
  if (ms === null) return [0, `頁面 25 秒內沒有穩定（轉圈取樣 ${l.spinnerSamples}/${l.samples}）`];
  if (l.fullPageSpinnerSeen) return [1, `載入中出現整頁轉圈，約 ${seconds}`];
  if (l.skeletonSeen && ms < 2500) return [4, `載入中有骨架畫面，約 ${seconds}`];
  if (l.spinnerSamples === 0) return [ms < 2500 ? 3 : 2, `沒有骨架畫面也沒有轉圈，約 ${seconds}才出現內容`];
  if (ms < 5000) return [2, `載入中是局部轉圈（${l.spinnerSamples}/${l.samples} 次取樣），約 ${seconds}`];
  return [1, `局部轉圈很久（${l.spinnerSamples}/${l.samples} 次取樣），約 ${seconds}`];
}

function nav(page, m) {
  const f = byId.get(page.id)?.facts;
  if (m.nav !== undefined) return [m.nav, m.navNote];
  if (!f) return null;
  const menu = Boolean(f.selectedMenu);
  const isDetail = page.layout === '詳情';
  const back = m.back ?? f.hasBackLink;
  let score = 0;
  if (menu) score += 2;
  if (isDetail ? back : true) score += 2;
  const parts = [];
  parts.push(menu ? `選單標出目前位置（${f.selectedMenu}）` : '選單沒有標出目前位置');
  if (isDetail) parts.push(back ? '有返回列表的連結' : '沒有返回列表的連結');
  return [score, parts.join('，')];
}

function visual(page, m) {
  const st = stats.pages[page.id];
  const f = byId.get(page.id)?.facts;
  let deduct = 0;
  const reasons = [];
  const dark = f?.siderDark === true;
  if (dark) {
    deduct += 1;
    reasons.push('後台殼層側欄是深色');
  } else reasons.push('殼層是亮色');
  if (st.inlineStyle >= 30) {
    deduct += 3;
  } else if (st.inlineStyle >= 10) deduct += 2;
  else if (st.inlineStyle >= 1) deduct += 1;
  reasons.push(`inline style ${st.inlineStyle} 處`);
  if (st.colorCodes >= 10) deduct += 1;
  if (st.colorCodes > 0) reasons.push(`寫死色碼 ${st.colorCodes} 處`);
  if (m.defect) {
    deduct += 1;
    reasons.push(m.defect);
  }
  return [Math.max(0, 4 - deduct), reasons.join('，')];
}

const out = { limitations: [] };
let missing = 0;
for (const page of PAGES) {
  const m = MANUAL[page.id];
  if (!m) {
    missing += 1;
    console.warn(`沒有手填評分：${page.id}`);
    continue;
  }
  if (m.note && !m.c) {
    out[page.id] = { note: m.note };
    continue;
  }
  const sp = speed(page.id);
  const nv = nav(page, m);
  if (!sp || !nv) {
    out[page.id] = { note: m.note ?? '沒有量測資料', manual: m.manual };
    continue;
  }
  const vs = visual(page, m);
  out[page.id] = {
    s: [sp[0], m.c[0], m.st[0], nv[0], vs[0], m.fb[0]],
    r: [sp[1], m.c[1], m.st[1], nv[1], vs[1], m.fb[1]],
    manual: m.manual ?? [],
    note: m.note,
  };
}

out.limitations = [
  '屋主資產總覽、屋主端移交清單與發起移交（19、20、21）接假資料 adapter，資料綁在虛構屋主的 ID。真實登入的帳號只看得到空狀態，有資料時的版面要等接線票（MIL-99、MIL-101、MIL-102、MIL-105 等）完成才能量測。',
  '屋主端移交詳情（22）沒有任何入口能進入，沒有截圖與評分。',
  '後台移交清單與詳情（24、25）顯示的是假資料 adapter 的預設執業主體資料（北辰），與登入的執業主體組織無關。第 25 頁的畫面與量測沿用第三輪（後續輪次的資料準備沒有取到移交 ID）。',
  '包租合約的執業人員與甲方是同一人，合併成兩位簽署人。三位不同簽署人的情境沒有驗收。',
  '代管案件（委託管理）沒有建立，社宅旗標編輯與衝突提示沒有驗收。',
  '速度量測在 dev server（webpack）上做，編譯與記憶體 PGlite 讓絕對數字偏高。比較前後時，以同樣的環境重跑，看有沒有骨架畫面與整頁轉圈。',
  '「回饋」的分數依原始碼的回饋呼叫（message、Modal.confirm、Alert）與驗收時實際看到的訊息判斷。沒有逐一操作每個按鈕。',
  'detect 的 P0 與 P1 對應規則是這份報告自己定的（見「怎麼量的」），impeccable 本身沒有 P0 到 P3 分級。',
];
writeFileSync(path.join(DATA, 'scores.json'), JSON.stringify(out, null, 2));
console.log(`scores.json 已寫入，沒有手填的頁面 ${missing} 個`);

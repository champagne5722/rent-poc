# 租賃合約簽約流程規格（房東端後台）

本文件彙整「[地圖：租賃合約簽約流程規格](https://linear.app/miles-rent-poc/issue/MIL-7/地圖租賃合約簽約流程規格)」八個決策票的結論，是可直接交付開發的規格。以**完整系統**（SaaS、使用者已登入、資料已隔離）角度撰寫，聚焦簽約流程；實作不在本文件範圍。

- 詞彙以 [CONTEXT.md](../CONTEXT.md) 為準；狀態機與資料模型見 [domain-model.md](./domain-model.md)。
- 技術前提（ADR 已定）：React + Ant Design（[ADR-0001](./adr/0001-react-antd-over-vue.md)）、Next.js 全端（[ADR-0002](./adr/0002-nextjs-fullstack-sqlite.md)）、點點簽 email 簽署與乙方先簽（[ADR-0003](./adr/0003-dottedsign-email-signing-client-credentials.md)）。
- 各節末尾的「決議來源」連到 Linear 票的 resolution comment 與 prototype 資產 branch；細節以票上決議為準，本文件是索引式的整合陳述。
- PoC 現況的刻意簡化（見[已知簡化清單](./known-simplifications.md)）**不是**本規格的一部分；正式版以本文件為準。

## 1. 目的與定位

房東在後台完成「建立物件 → 擬約 → 設定簽署區 → 送簽 → 雙方電子簽署 → 保存已簽文件與稽核憑證」的完整簽約流程。租客不進系統，只透過點點簽（DottedSign）的 email 連結簽署。

## 2. 範圍與前提

**前提**：使用者（房東）已登入，資料按帳號隔離；帳號體系（註冊／登入／訂閱計費）屬另一張地圖。範本與選用條款由平台提供且經法務審閱。

**本規格涵蓋**：後台資訊架構與導覽、工作台、合約列表、建約流程、合約詳情頁、簽署流程與狀態機、修約／重送、合約歷程與稽核、範本管理（使用者端視角）。

**範圍外**：見[第 16 節](#16-範圍外out-of-scope)。

## 3. 角色

| 角色 | 說明 |
|---|---|
| 房東（Landlord） | 系統操作者、合約甲方。所有後台功能面向房東。 |
| 租客（Tenant） | 合約乙方。不進系統；收點點簽 email 完成簽署或拒簽。 |

## 4. 資訊架構與導覽

- **殼層**：深色 collapsible side menu——antd `Layout`＋`Sider`＋`Menu mode="inline"` 純 v6 組合；**不引入 ProLayout**（antd v6 支援僅 beta、無 App Router 官方支援）。
- **一級頁面與選單**：工作台（**預設落地頁**，路徑 `/`）、物件、合約。層級少於三層，**不用 breadcrumb**。
- **常駐建約入口**：側邊選單頂部固定「＋建立合約」主 CTA，任何頁面可見；工作台快捷入口與物件頁的「建立合約」保留。
- **主動線**：建約（sider CTA 或物件頁）→ 建約 wizard → 送簽 → 回工作台待辦／合約列表追蹤簽署進度。

決議來源：[後台整體資訊架構與導覽](https://linear.app/miles-rent-poc/issue/MIL-9/後台整體資訊架構與導覽)；prototype 在 branch `prototype/mil-9-ia-shell`。

## 5. 工作台

登入後預設落地頁，**精簡三模組**，不加第 4 個模組：

1. **核心數據 4 卡**：物件、簽署中、待我處理、已完成——卡片可點，連到對應頁面。
2. **待辦（窄規則）**：只收「等房東動作、流程才會前進」的合約——待甲方簽（行動＝去簽署，連詳情頁）與草稿（行動＝繼續編輯，進 wizard）。**已拒簽／已撤回不入待辦**（那是「決定要不要重來」，由合約列表承接，工作台不重複）。排序依最後動作時間新到舊。
3. **快捷入口**：建立合約（primary）、查看全部合約、管理物件。

決議來源：[工作台頁面內容](https://linear.app/miles-rent-poc/issue/MIL-17/工作台頁面內容)；prototype 在 branch `prototype/mil-17-workbench-content`。

## 6. 合約列表與狀態追蹤

**狀態分頁工作清單**：

- **狀態導覽**：頂部 Segmented「全部＋六狀態」，各帶即時計數，是列表的第一層導覽。
- **欄位**：#、物件、乙方（租客）、租金、租期、狀態 Tag、簽署進度、最後動作時間（更新時間，無則建立時間）。
- **排序**：預設「進行中優先」——簽署中 → 草稿 → 拒簽／撤回 → 已完成，同組內依最後動作時間新到舊。
- **篩選**：狀態 Segmented＋物件下拉＋租期涵蓋區間（與合約租期重疊即命中）。
- **簽署進度視覺化**：三顆進度點（乙方簽 → 甲方簽 → 完成）；簽署流程外的狀態（草稿／拒簽／撤回）顯示「—」。
- **列上快速操作**（依狀態）：草稿＝繼續編輯（進 wizard）、簽署中＝撤回（確認後執行）、已完成＝下載已簽 PDF、已拒簽／已撤回＝複製為新草稿；所有列固定有「開啟」進詳情頁。

決議來源：[合約列表與狀態追蹤頁](https://linear.app/miles-rent-poc/issue/MIL-10/合約列表與狀態追蹤頁)；prototype 在 branch `prototype/mil-10-contract-list`。

## 7. 建約流程（分步 wizard）

**流程結構＝分步 wizard**（官方 Step Form 模式），草稿的編輯體驗一律在 wizard 內：

1. **物件與範本**：選物件帶入快照；選範本（單範本時自動選用、步驟隱藏為說明，多範本時成為選擇步驟）＋**選用條款**勾選。
2. **填寫欄位**：分組（雙方資訊／租金與租期＋其他約定事項），逐步擋驗證。
3. **預覽與簽署區**：PDF 預覽上拖放簽名框，側欄即時檢核。
4. **確認送簽**：欄位摘要＋選用條款＋簽署區檢核＋「乙方先簽」預期說明。

**簽署區互動五點基線**：

1. 預設位置：新增簽名框自動落在範本簽名頁的甲／乙簽名欄附近。
2. 對齊輔助：拖曳吸附＋對齊線（同頁其他框、頁緣邊距）。
3. 多頁：每頁可加框；檢核＝甲乙雙方各至少一框（第 3 步擋下一步）。
4. 錯置防呆：出界自動夾回、甲乙框重疊警示、確認頁列出每框簽署方＋頁碼。
5. 草稿保全：每按「下一步」自動儲存草稿，可中途離開續作。

決議來源：[建約與簽署區設定 UX](https://linear.app/miles-rent-poc/issue/MIL-12/建約與簽署區設定-ux)；prototype 在 branch `prototype/mil-12-creation-ux`。

## 8. 合約詳情頁

**分頁型佈局**：

- **頁首**：合約編號＋狀態 Tag＋物件與乙方摘要；右側為依狀態的操作按鈕——草稿＝繼續編輯（進 wizard）、簽署中＝撤回（確認後執行）、已完成＝下載已簽 PDF、已拒簽／已撤回＝複製為新草稿。
- **Tabs 四分頁**：
  1. **合約內容**：合約摘要＋PDF 預覽（簽署框唯讀顯示）。
  2. **歷程**：里程碑事件時間軸（時間、行為者、附註如拒簽原因），頂部固定說明「活動歷程定位、法律舉證以點點簽 Audit Trail File 為準」。
  3. **文件**：已簽 PDF＋點點簽 Audit Trail File 兩列；未完成狀態顯示「尚未產生」，完成後提供下載。
  4. **關聯合約**：衍生鏈卡片（前身 → 本約 → 後繼，各帶狀態 Tag 與連結）；無關聯時註明「僅撤回修約路徑會記錄」。
- **草稿角色**：詳情頁只顯示摘要＋PDF 預覽，主 CTA「繼續編輯」進 wizard，不在詳情頁編輯欄位。

決議來源：[合約詳情頁](https://linear.app/miles-rent-poc/issue/MIL-11/合約詳情頁)；prototype 在 branch `prototype/mil-11-detail-page`。

## 9. 簽署流程與狀態機

- 簽署經點點簽 email 通知完成，**乙方（租客）先簽、甲方（房東）後簽**（`has_order: true`；ADR-0003）。不做站內 embedded signing。
- 六態狀態機（`draft` → `awaiting_tenant` → `awaiting_landlord` → `completed`，分支 `declined`／`voided`）與轉移規則見 [domain-model.md](./domain-model.md)；**狀態機不擴充**（ADR-0006 確認六態不變）。
- 狀態轉移由點點簽 webhook 事件驅動（撤回為系統主動呼叫後更新）；webhook 事件與合約歷程事件**同一次交易**寫入，保證歷程與狀態一致（ADR-0007）。
- 合約完成時系統自動保存**已簽 PDF**與**點點簽 Audit Trail File**（與已簽 PDF 並列；`sign_tasks.download.read` scope、`file_types[]=audit_trail`）。
- 點點簽整合細節（API、webhook、欄位轉換）見[整合筆記](./dottedsign-integration.md)。

## 10. 修約與重送

- **修約＝撤回 → 複製為新草稿 → 重新編輯送簽**，新草稿記錄「衍生自」哪份撤回合約（衍生關聯）；不做送簽後原地改約、不做合約實體內版本化（合約不可變，ADR-0006）。
- **拒簽＝交易終點語意**：不算重議流程、不記衍生關聯；declined 保留「複製為新草稿」按鈕作純省時便利。
- 衍生鏈在詳情頁「關聯合約」分頁呈現（見第 8 節）。
- 續約機制與到期標示**這輪不做**（範圍外；未來預期沿用「複製＋關聯」模型）。

決議來源：[修約／續約／重送流程](https://linear.app/miles-rent-poc/issue/MIL-13/修約續約重送流程)；[ADR-0006](./adr/0006-immutable-contracts-derivation-instead-of-amendment.md)。

## 11. 合約歷程與稽核

- **定位＝活動歷程**，非稽核級紀錄。法律舉證交給點點簽——任務完成時自動產生受其數位簽章保護的 **Audit Trail File**（含各方姓名、Email、時間戳、IP、裝置），平台不重做稽核級紀錄。
- **只記里程碑事件**：建立（含衍生來源）、送簽、乙方簽署、拒簽（含原因）、甲方簽署完成、撤回、被複製為新草稿。草稿編輯流水與下載／查看等讀式操作不記。
- **Contract Event**：附屬合約的 append-only 事件序列（型別、行為者、時間、附註）；隨合約生命週期保存，UI 無編輯刪除。
- 呈現位置＝詳情頁「歷程」分頁（見第 8 節）。

決議來源：[合約歷程與稽核紀錄](https://linear.app/miles-rent-poc/issue/MIL-15/合約歷程與稽核紀錄)；[ADR-0007](./adr/0007-activity-history-audit-delegated-to-dottedsign.md)；點點簽簽署歷程研究筆記在 branch `research/dottedsign-signing-history`。

## 12. 範本管理

- **範本一律由平台提供**（依內政部住宅租賃定型化契約精神、經法務審閱），不開放使用者自建範本或編輯條款全文；使用者端**沒有**範本編輯介面（範本維護歸平台營運 Admin 後台，範圍外）。
- **逐約條款彈性三層**：可編輯欄位＋平台「選用條款」庫（寵物、轉租、提前解約違約金等，逐約勾選、經法務審閱）＋自由文字「其他約定事項」欄。
- **架構支援多範本、首發一份**住宅租賃範本；建約流程含選範本步驟（單範本時隱藏）。
- **版本化＋建約即快照**：範本與選用條款皆有版本；合約建立時綁定版本並快照條款內容，改版不回溯影響既有合約（含草稿）；草稿送簽前若有新版，提示可升版重建但不強制。

決議來源：[範本管理](https://linear.app/miles-rent-poc/issue/MIL-14/範本管理)；[ADR-0005](./adr/0005-platform-managed-templates-with-optional-clauses.md)。

## 13. 資料模型

概念層資料模型（Property、Contract、Contract Event、快照原則、衍生關聯）以 [domain-model.md](./domain-model.md) 為準。規格層面的關鍵約束：

- Contract 引用 Property 與範本後**即成快照**，來源修改不回溯影響。
- Contract **不可變**（送簽後）；變更一律走衍生新約。
- Contract Event **append-only**、與狀態轉移同交易寫入。
- 完成時保存已簽 PDF 與 Audit Trail File，隨合約保存。

## 14. User Stories

1. 身為房東，我要登入後先看到工作台，快速掌握物件數、簽署中、待我處理與已完成的概況。
2. 身為房東，我要在工作台待辦看到等我簽署與還沒送簽的合約並一鍵前往，讓流程不中斷。
3. 身為房東，我要在任何頁面按「＋建立合約」開始建約，不必先找到入口。
4. 身為房東，我要在建約第一步選物件並自動帶入其資料，免得重複輸入。
5. 身為房東，我要勾選平台提供的選用條款（寵物、轉租、提前解約違約金等），讓合約貼合這次出租的條件而不必自己寫條款。
6. 身為房東，我要在「其他約定事項」自由補充個別約定，涵蓋選用條款以外的需求。
7. 身為房東，我要分步驟填寫合約欄位並在每步通過驗證，避免送簽後才發現缺漏。
8. 身為房東，我要在 PDF 預覽上直接拖放甲乙雙方的簽名框（含吸附對齊與防呆），確保簽名位置正確。
9. 身為房東，我要 wizard 每步自動存草稿，中途離開也能從詳情頁「繼續編輯」續作。
10. 身為房東，我要在確認頁看到欄位摘要、選用條款、簽署區檢核與「乙方先簽」說明後再送簽，送出前有最後把關。
11. 身為租客，我要收到點點簽 email 完成線上簽署或拒簽（可附原因），不需要註冊任何帳號。
12. 身為房東，我要在租客簽署完成後收到待辦提示並完成我方簽署，讓合約成立。
13. 身為房東，我要在合約列表用狀態分頁與計數快速切到某一狀態的合約。
14. 身為房東，我要列表預設把「進行中」排前面，先看到需要關注的合約。
15. 身為房東，我要用物件與租期區間篩選合約，快速找到特定合約。
16. 身為房東，我要在列表的每一列直接執行該狀態的下一步（繼續編輯／撤回／下載／複製），不必先進詳情頁。
17. 身為房東，我要在詳情頁分頁查看合約內容、歷程、文件與關聯合約，資訊分類清楚。
18. 身為房東，我要在歷程分頁看到誰在何時做了什麼（含拒簽原因），掌握合約走到哪裡。
19. 身為房東，我要在合約完成後下載已簽 PDF 與點點簽 Audit Trail File，作為留存與法律舉證。
20. 身為房東，我要撤回簽署中的合約並複製為新草稿修改重送（系統記錄衍生關聯），處理條件談變的情況。
21. 身為房東，我要在詳情頁看到修約的衍生鏈（舊約與新約互連），追蹤合約的來龍去脈。
22. 身為房東，我要被拒簽的合約也能複製為新草稿，免得重打全部欄位。

## 15. 測試取向

- 只測外部行為，不測實作細節。
- **狀態機與事件**：以 webhook 事件輸入驗證狀態轉移與 Contract Event 同交易寫入的一致性（最高 seam：API／webhook 層）。
- **建約 wizard**：逐步驗證擋下與草稿保全；簽署區檢核（甲乙各至少一框）擋送簽。
- **快照與衍生**：物件／範本改版不影響既有合約；撤回→複製記關聯、拒簽→複製不記。
- **文件保存**：完成時已簽 PDF 與 Audit Trail File 可下載。

## 16. 範圍外（Out of scope）

- 平台營運 Admin 後台（含範本與選用條款維護介面）。
- 帳號體系（註冊／登入／訂閱計費）——另開地圖。
- 續約機制與到期標示（未來預期沿用「複製＋關聯」模型）。
- 簽署期限與逾期提醒通知。
- 租客端體驗（狀態查看頁、通知內容）。
- 附件支援（屋況照片等）。
- 站內簽署（embedded signing）——維持 email 簽署。
- 改派簽署人。

## 附錄 A：決議與資產索引

| 決議票 | 產出 |
|---|---|
| [Ant Design 後台佈局與 Dashboard 指引研究](https://linear.app/miles-rent-poc/issue/MIL-8/ant-design-後台佈局與-dashboard-指引研究) | 研究筆記：branch `research/antd-dashboard-guidance` |
| [後台整體資訊架構與導覽](https://linear.app/miles-rent-poc/issue/MIL-9/後台整體資訊架構與導覽) | prototype：branch `prototype/mil-9-ia-shell` |
| [合約列表與狀態追蹤頁](https://linear.app/miles-rent-poc/issue/MIL-10/合約列表與狀態追蹤頁) | prototype：branch `prototype/mil-10-contract-list` |
| [合約詳情頁](https://linear.app/miles-rent-poc/issue/MIL-11/合約詳情頁) | prototype：branch `prototype/mil-11-detail-page` |
| [建約與簽署區設定 UX](https://linear.app/miles-rent-poc/issue/MIL-12/建約與簽署區設定-ux) | prototype：branch `prototype/mil-12-creation-ux` |
| [修約／續約／重送流程](https://linear.app/miles-rent-poc/issue/MIL-13/修約續約重送流程) | [ADR-0006](./adr/0006-immutable-contracts-derivation-instead-of-amendment.md) |
| [範本管理](https://linear.app/miles-rent-poc/issue/MIL-14/範本管理) | [ADR-0005](./adr/0005-platform-managed-templates-with-optional-clauses.md) |
| [合約歷程與稽核紀錄](https://linear.app/miles-rent-poc/issue/MIL-15/合約歷程與稽核紀錄) | [ADR-0007](./adr/0007-activity-history-audit-delegated-to-dottedsign.md)、研究筆記：branch `research/dottedsign-signing-history` |
| [工作台頁面內容](https://linear.app/miles-rent-poc/issue/MIL-17/工作台頁面內容) | prototype：branch `prototype/mil-17-workbench-content` |

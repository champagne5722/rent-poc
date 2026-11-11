# UI 重構最終驗收（MIL-185）

UI 重構（MIL-167）的五個階段都已完成。全站 37 頁重新截圖、評分，並用 impeccable 掃渲染後的頁面。

- 整體分數：前後都有分數的 34 頁，平均合計從 14.0 升到 21.0（滿分 24）。
- audit：P0 從 1 降到 0，P1 從 16 降到 0。無障礙與響應式不列入。
- inline style：從 297 處降到 21 處，剩下的全在承租人端與 demo 頁，不在重構範圍。
- 寫死色碼：從 20 處降到 0 處。
- antd 已棄用 API：從 21 處降到 0 處。
- lint：擋 inline style 的規則是錯誤等級，基準檔已刪除。

## 總表

分數 0 到 4，滿分 24，規則與 [重構前基準](../baseline/README.md) 相同。欄位依序是速度、一致、狀態一眼看懂、導覽、視覺、回饋。P0 與 P1 是 impeccable audit 加人工複查的數量，無障礙與響應式不列入。
前後各一格：「前」是重構前基準，「後」是這次重拍。沒有前分數的頁面是基準之後才有畫面的頁。

| 頁面 | 重構票 | 前 6 項 | 前合計 | 後 6 項 | 後合計 | 後 P0 / P1 | 前圖 | 後圖 |
| -- | -- | -- | -- | -- | -- | -- | -- | -- |
| 01-workbench 工作台 | MIL-178 | 4 / 2 / 2 / 4 / 1 / 1 | 14 | 3 / 3 / 3 / 4 / 4 / 1 | 18 | 0 / 0 | [前](../baseline/01-workbench.png) | [後](01-workbench.png) |
| 02-contracts-list 合約列表 | MIL-174 | 3 / 2 / 3 / 4 / 1 / 2 | 15 | 3 / 4 / 4 / 4 / 4 / 3 | 22 | 0 / 0 | [前](../baseline/02-contracts-list.png) | [後](02-contracts-list.png) |
| 03-contract-detail-signing 合約詳情（簽署中） | MIL-175 | 2 / 2 / 3 / 2 / 0 / 3 | 12 | 2 / 4 / 4 / 4 / 4 / 3 | 21 | 0 / 0 | [前](../baseline/03-contract-detail-signing.png) | [後](03-contract-detail-signing.png) |
| 04-contract-detail-completed 合約詳情（已完成） | MIL-175 | 2 / 2 / 2 / 2 / 1 / 3 | 12 | 2 / 4 / 4 / 4 / 4 / 3 | 21 | 0 / 0 | [前](../baseline/04-contract-detail-completed.png) | [後](04-contract-detail-completed.png) |
| 05-contract-detail-draft 合約詳情（草稿） | MIL-175 | 2 / 2 / 3 / 2 / 1 / 3 | 13 | 4 / 4 / 4 / 4 / 4 / 3 | 23 | 0 / 0 | [前](../baseline/05-contract-detail-draft.png) | [後](05-contract-detail-draft.png) |
| 06-contract-detail-declined 合約詳情（已拒簽） | MIL-175 | 2 / 2 / 2 / 2 / 1 / 3 | 12 | 4 / 4 / 4 / 4 / 4 / 3 | 23 | 0 / 0 | [前](../baseline/06-contract-detail-declined.png) | [後](06-contract-detail-declined.png) |
| 07-wizard-1-property 建約精靈 步驟一 物件摘要 | MIL-176 | 3 / 2 / 2 / 4 / 0 / 3 | 14 | 3 / 4 / 3 / 4 / 4 / 3 | 21 | 0 / 0 | [前](../baseline/07-wizard-1-property.png) | [後](07-wizard-1-property.png) |
| 08-wizard-2-fields 建約精靈 步驟二 填欄位 | MIL-176 | 3 / 2 / 2 / 4 / 0 / 3 | 14 | 4 / 4 / 3 / 4 / 4 / 3 | 22 | 0 / 0 | [前](../baseline/08-wizard-2-fields.png) | [後](08-wizard-2-fields.png) |
| 09-wizard-3-signature 建約精靈 步驟三 簽署區 | MIL-176 | 2 / 2 / 3 / 4 / 0 / 3 | 14 | 3 / 4 / 4 / 4 / 4 / 3 | 22 | 0 / 0 | [前](../baseline/09-wizard-3-signature.png) | [後](09-wizard-3-signature.png) |
| 10-wizard-4-confirm 建約精靈 步驟四 確認送簽 | MIL-176 | 2 / 2 / 3 / 4 / 0 / 3 | 14 | 4 / 4 / 4 / 4 / 4 / 3 | 23 | 0 / 0 | [前](../baseline/10-wizard-4-confirm.png) | [後](10-wizard-4-confirm.png) |
| 11-properties-list 物件列表 | MIL-177 | 2 / 2 / 2 / 4 / 0 / 3 | 13 | 4 / 4 / 4 / 4 / 4 / 3 | 23 | 0 / 0 | [前](../baseline/11-properties-list.png) | [後](11-properties-list.png) |
| 12-property-detail 物件詳情 | MIL-177 | 3 / 2 / 2 / 4 / 2 / 3 | 16 | 4 / 4 / 4 / 4 / 3 / 3 | 22 | 0 / 0 | [前](../baseline/12-property-detail.png) | [後](12-property-detail.png) |
| 13-cases-list 案件列表 | MIL-184 | 2 / 2 / 2 / 4 / 2 / 1 | 13 | 2 / 4 / 4 / 4 / 4 / 1 | 19 | 0 / 0 | [前](../baseline/13-cases-list.png) | [後](13-cases-list.png) |
| 14-case-detail-overview 案件詳情（概況） | MIL-184 | 3 / 2 / 3 / 4 / 2 / 2 | 16 | 4 / 4 / 4 / 4 / 4 / 3 | 23 | 0 / 0 | [前](../baseline/14-case-detail-overview.png) | [後](14-case-detail-overview.png) |
| 15-case-detail-ledger 案件詳情（帳務設定） | MIL-184 | 3 / 2 / 3 / 4 / 2 / 3 | 17 | 4 / 3 / 4 / 4 / 4 / 3 | 22 | 0 / 0 | [前](../baseline/15-case-detail-ledger.png) | [後](15-case-detail-ledger.png) |
| 16-payment-accounts 收款帳戶 | MIL-181 | 2 / 2 / 3 / 4 / 2 / 3 | 16 | 3 / 4 / 4 / 4 / 4 / 3 | 22 | 0 / 0 | [前](../baseline/16-payment-accounts.png) | [後](16-payment-accounts.png) |
| 17-notifications 站內通知 | MIL-179 | 3 / 1 / 1 / 4 / 2 / 2 | 13 | 3 / 4 / 3 / 4 / 4 / 3 | 21 | 0 / 0 | [前](../baseline/17-notifications.png) | [後](17-notifications.png) |
| 18-members 成員設定 | MIL-181 | 2 / 1 / 2 / 2 / 2 / 3 | 12 | 4 / 4 / 3 / 4 / 4 / 3 | 22 | 0 / 0 | [前](../baseline/18-members.png) | [後](18-members.png) |
| 19-owner-overview 屋主資產總覽 | MIL-182 | 3 / 2 / 1 / 4 / 3 / 1 | 14 | 3 / 3 / 1 / 4 / 4 / 1 | 16 | 0 / 0 | [前](../baseline/19-owner-overview.png) | [後](19-owner-overview.png) |
| 20-owner-handovers 屋主端 移交清單 | MIL-182 | 3 / 2 / 1 / 4 / 3 / 2 | 15 | 3 / 3 / 3 / 4 / 4 / 2 | 19 | 0 / 0 | [前](../baseline/20-owner-handovers.png) | [後](20-owner-handovers.png) |
| 21-owner-handover-new 屋主端 發起移交 | MIL-182 | 3 / 2 / 1 / 4 / 3 / 2 | 15 | 3 / 3 / 1 / 4 / 4 / 2 | 17 | 0 / 0 | [前](../baseline/21-owner-handover-new.png) | [後](21-owner-handover-new.png) |
| 22-owner-handover-detail 屋主端 移交詳情 | MIL-182 | - | - | 4 / 4 / 4 / 4 / 4 / 3 | 23 | 0 / 0 | - | [後](22-owner-handover-detail.png) |
| 23-owner-case-detail 屋主端 案件詳情 | MIL-184 | 2 / 2 / 3 / 2 / 3 / 2 | 14 | 2 / 4 / 4 / 3 / 4 / 2 | 19 | 0 / 0 | [前](../baseline/23-owner-case-detail.png) | [後](23-owner-case-detail.png) |
| 24-org-handovers 後台 移交清單 | MIL-182 | 3 / 2 / 3 / 4 / 2 / 1 | 15 | 3 / 4 / 4 / 4 / 4 / 1 | 20 | 0 / 0 | [前](../baseline/24-org-handovers.png) | [後](24-org-handovers.png) |
| 25-org-handover-detail 後台 移交詳情 | MIL-182 | 3 / 2 / 2 / 2 / 2 / 3 | 14 | 3 / 4 / 4 / 4 / 4 / 3 | 22 | 0 / 0 | [前](../baseline/25-org-handover-detail.png) | [後](25-org-handover-detail.png) |
| 26-practice 執業主體 | MIL-181 | 3 / 1 / 2 / 4 / 1 / 2 | 13 | 4 / 4 / 3 / 4 / 4 / 3 | 22 | 0 / 0 | [前](../baseline/26-practice.png) | [後](26-practice.png) |
| 27-practitioner 我的證書（執業人員） | MIL-181 | 3 / 1 / 3 / 4 / 1 / 3 | 15 | 3 / 4 / 4 / 4 / 4 / 3 | 22 | 0 / 0 | [前](../baseline/27-practitioner.png) | [後](27-practitioner.png) |
| 28-desk-queue 審核台佇列 | MIL-180 | 2 / 2 / 2 / 4 / 2 / 1 | 13 | 4 / 4 / 4 / 4 / 4 / 1 | 21 | 0 / 0 | [前](../baseline/28-desk-queue.png) | [後](28-desk-queue.png) |
| 29-desk-item-license 審核台項目（業別核對） | MIL-180 | 3 / 2 / 2 / 4 / 1 / 3 | 15 | 4 / 4 / 4 / 4 / 4 / 3 | 23 | 0 / 0 | [前](../baseline/29-desk-item-license.png) | [後](29-desk-item-license.png) |
| 30-desk-item-credential 審核台項目（證書或任職核對） | MIL-180 | 3 / 2 / 2 / 4 / 1 / 3 | 15 | 3 / 4 / 4 / 4 / 4 / 3 | 22 | 0 / 0 | [前](../baseline/30-desk-item-credential.png) | [後](30-desk-item-credential.png) |
| 31-login 登入頁 | MIL-183 | 2 / 2 / 2 / 3 / 3 / 3 | 15 | 3 / 3 / 3 / 3 / 4 / 3 | 19 | 0 / 0 | [前](../baseline/31-login.png) | [後](31-login.png) |
| 32-onboarding 登入後選身分（第一次登入） | MIL-183 | 3 / 2 / 2 / 3 / 3 / 3 | 16 | 4 / 3 / 3 / 3 / 4 / 3 | 20 | 0 / 0 | [前](../baseline/32-onboarding.png) | [後](32-onboarding.png) |
| 33-master-lease-detail 合約詳情（包租，執業人員兼甲方） | MIL-175 | 1 / 2 / 3 / 2 / 1 / 3 | 12 | 4 / 4 / 4 / 4 / 4 / 3 | 23 | 0 / 0 | [前](../baseline/33-master-lease-detail.png) | [後](33-master-lease-detail.png) |
| 34-master-lease-wizard-fields 建約精靈 包租 步驟四（附件與簽署序列） | MIL-176 | 2 / 2 / 2 / 4 / 0 / 3 | 13 | 4 / 4 / 3 / 4 / 4 / 3 | 22 | 0 / 0 | [前](../baseline/34-master-lease-wizard-fields.png) | [後](34-master-lease-wizard-fields.png) |
| 35-design 設計樣式頁（內部工具） | MIL-171 | 3 / 1 / 2 / 4 / 1 / 1 | 12 | 3 / 3 / 3 / 4 / 4 / 1 | 18 | 0 / 0 | [前](../baseline/35-design.png) | [後](35-design.png) |
| 36-mgmt-wizard-3-signature 建約精靈 委託管理 步驟三 簽署區 | MIL-176 | - | - | 2 / 4 / 4 / 4 / 4 / 3 | 21 | 0 / 0 | - | [後](36-mgmt-wizard-3-signature.png) |
| 37-mgmt-wizard-2-fields 建約精靈 委託管理 步驟二 填欄位與委託標的 | MIL-176 | - | - | 4 / 4 / 3 / 4 / 4 / 3 | 22 | 0 / 0 | - | [後](37-mgmt-wizard-2-fields.png) |
| **平均（前後都有分數的 34 頁）** | | 2.6 / 1.9 / 2.2 / 3.5 / 1.4 / 2.4 | 14.0 | 3.3 / 3.8 / 3.5 / 3.9 / 4.0 / 2.6 | 21.0 | 0 / 0（全 37 頁） | | |

六項順序：速度、一致、狀態、導覽、視覺、回饋。前後的合計是各項平均相加。

## impeccable audit

做法是渲染後掃描：測試自己啟動 Chromium 並開 CDP port，每頁載入後執行 `impeccable detect --cdp`。不是掃原始碼。分級規則與重構前基準相同：severity 為 error 算 P0，quality 類的 warning 算 P1，其餘列為其他。全站 37 頁的結果是 P0 0、P1 0。

| 頁面 | P0 | P1 | 其他（slop 與 advisory） | 已排除（無障礙與響應式） |
| -- | -- | -- | -- | -- |
| 01-workbench | 0 | 0 | 0 | 0 |
| 02-contracts-list | 0 | 0 | 0 | 8 |
| 03-contract-detail-signing | 0 | 0 | 0 | 7 |
| 04-contract-detail-completed | 0 | 0 | 0 | 5 |
| 05-contract-detail-draft | 0 | 0 | 0 | 3 |
| 06-contract-detail-declined | 0 | 0 | 0 | 7 |
| 07-wizard-1-property | 0 | 0 | 1 | 5 |
| 08-wizard-2-fields | 0 | 0 | 0 | 9 |
| 09-wizard-3-signature | 0 | 0 | 0 | 7 |
| 10-wizard-4-confirm | 0 | 0 | 1 | 4 |
| 11-properties-list | 0 | 0 | 0 | 6 |
| 12-property-detail | 0 | 0 | 0 | 5 |
| 13-cases-list | 0 | 0 | 0 | 6 |
| 14-case-detail-overview | 0 | 0 | 1 | 13 |
| 15-case-detail-ledger | 0 | 0 | 1 | 13 |
| 16-payment-accounts | 0 | 0 | 0 | 4 |
| 17-notifications | 0 | 0 | 0 | 1 |
| 18-members | 0 | 0 | 0 | 2 |
| 19-owner-overview | 0 | 0 | 0 | 1 |
| 20-owner-handovers | 0 | 0 | 0 | 2 |
| 21-owner-handover-new | 0 | 0 | 0 | 3 |
| 22-owner-handover-detail | 0 | 0 | 0 | 11 |
| 23-owner-case-detail | 0 | 0 | 1 | 13 |
| 24-org-handovers | 0 | 0 | 0 | 7 |
| 25-org-handover-detail | 0 | 0 | 0 | 9 |
| 26-practice | 0 | 0 | 0 | 8 |
| 27-practitioner | 0 | 0 | 0 | 4 |
| 28-desk-queue | 0 | 0 | 0 | 4 |
| 29-desk-item-license | 0 | 0 | 0 | 5 |
| 30-desk-item-credential | 0 | 0 | 0 | 3 |
| 31-login | 0 | 0 | 0 | 2 |
| 32-onboarding | 0 | 0 | 0 | 1 |
| 33-master-lease-detail | 0 | 0 | 0 | 7 |
| 34-master-lease-wizard-fields | 0 | 0 | 1 | 5 |
| 35-design | 0 | 0 | 5 | 14 |
| 36-mgmt-wizard-3-signature | 0 | 0 | 0 | 8 |
| 37-mgmt-wizard-2-fields | 0 | 0 | 0 | 7 |

其他類（不算 P0 與 P1）：nested-cards ×11。明細在 `data/results.json`。

## 靜態統計

| 項目 | 重構前 | 現在 |
| -- | -- | -- |
| src/app 與 src/components 的 inline style | 297 | 21（都在承租人端與 demo 頁） |
| 寫死色碼 | 20 | 0 |
| 寫死 px | 78 | 37 |
| antd 已棄用 API | 21 | 0 |
| 殼層與跨頁元件的 inline style | 14 | 0 |

數字取自 `docs/ui/final/data/static-stats.json`，掃 `src/app` 與 `src/components`。「重構前」取自基準報告。寫死 px 剩下的是 1px 邊線、響應式斷點、簽署區域編輯器的對齊線與設計展示頁的固定展示尺寸。它們不屬於 DESIGN.md 的 spacing token，保留。

## 各階段的重點改動

用「模組現在能做什麼」的角度寫。

- **階段 0 與 1，基礎**：改外觀只改 `DESIGN.md` 一份檔。字級有 4 級。後台與屋主端共用亮色外觀與同一條頂部列。同一個狀態在每一頁同名同色。列表頁版型、詳情頁版型、空狀態與骨架畫面成為共用元件。
- **階段 2，合約詳情與建約精靈**：合約詳情頂端寫出目前狀態、卡在哪一步與下一步輪到誰，並有返回合約列表的連結。簽署進度列出每位簽署人。建約精靈的步驟條固定在上方，按鈕列固定在下方，草稿儲存狀態與送出前摘要都看得到。租賃與委託管理的精靈同一套結構。
- **階段 3，物件**：物件列表依物件分組，有篩選列與核對狀態。物件詳情有下一步區塊與返回連結，從物件直接建立案件。
- **階段 4，其他頁面**：工作台列出待我處理的事。站內通知的未讀列有標示，能標已讀。案件列表與詳情沿用列表與詳情版型，帳務設定三個表單同版型。成員、執業主體、我的證書、收款帳戶用同一套設定頁版型。移交頁與屋主資產總覽沿用共用元件。審核台佇列與項目詳情沿用列表與詳情版型。登入頁與後台同一套外觀。
- **階段 5，收尾（本票）**：lint 擋 inline style 的規則改為錯誤。已棄用 API 清到 0。執業主體頁與通知頁的 hydration 錯誤修掉。每個畫面至多一顆 primary 按鈕。屋主端移交詳情有資料可看。

## 這一次發現並處理的問題

- **執業主體頁的 hydration 錯誤（audit P0）**：原因是 `Intl.DateTimeFormat` 的 `dateStyle` 與 `timeStyle`。Node 與 Chromium 的 ICU 在日期與時間之間用不同的空白字元。改用共用的 `formatTaipeiDateTime`，通知頁有同樣寫法，一併修掉。新增流程測試，斷言 `/practice` 載入後沒有 console error 與 pageerror。
- **首屏欄位溢出（audit P1）**：建約精靈步驟三與屋主端移交詳情都是「一欄很高、另一欄很短」。精靈改成檢核卡在上、預覽在下。移交詳情的內容改成橫跨全寬，屬性卡在上方。
- **一畫面一顆 primary**：側欄「建立合約」降為 default，頁面自己的主要動作保留 primary。
- **帳號列換行**：長組織名稱在一行內截斷，登出按鈕留在 48px 的頂部列內。
- **平台營運者的側欄（人工 P1，MIL-191）**：營運者登入後，側欄只剩「審核台」，不再列屋主功能與「建立合約」。選單規則（`nav.ts`）沒有改，只在殼層依身分略過共用項目。

## 主控追加項目的結果

- **primary 按鈕**：側欄「建立合約」是 default。全站每個畫面的 primary 不超過 1 顆，只有設計樣式頁（內部展示）有 2 顆。數字取自每頁的 `facts.primaryButtons`。
- **通知未讀列**：通知頁截圖（17）有一筆未讀，流程測試有標已讀的斷言。
- **帳號列**：執業主體使用者（26、27）的帳號名稱在一行內截斷，頂部列維持 48px。
- **成員管理**：已在側欄。最終 audit 沒有 bounce-easing 發現，不是 P1。

## 已知限制與後續建議

- **承租人端與 demo 頁**：不在 MIL-167 範圍。它們仍有 inline style，lint 規則對它們關閉。建議另開一張票重構承租人端。
- **手機版與平板版、深色模式、無障礙標準**：不在範圍。audit 的低對比與標題層級類發現已排除，仍留在 `data/results.json`。
- **屋主資產總覽、移交清單與發起移交**：資料還在記憶體 adapter，真實登入的屋主看到空狀態。移交詳情靠 `/api/demo/handover` 準備一筆草稿才有畫面。MIL-105 接上資料庫後，刪除這個 route。
- **屋主端移交詳情的接收方清單**：記憶體 adapter 依虛構屋主 ID 讀候選接收方，真實屋主讀到空清單，所以截圖的「誰接手」是空的。
- **委託管理精靈步驟四**：草稿要先指派執業人員才能到最後一步，截圖資料沒有備。步驟二與步驟三有截圖。
- **載入失敗畫面**：唯讀列表沒有全站共用的錯誤頁，「回饋」分數因此停在 1 到 2。建議補一個共用的 `error.tsx`。
- **速度量測**：在 dev server 上做，絕對數字偏高。合約詳情的 PDF 預覽逐頁轉圖，穩定時間落差大。
- **評分是人工判斷**：一致、狀態、回饋由評分者看截圖給分，速度、導覽、視覺由量測與靜態統計算出。
- **評分尺度**：沿用基準的 0 到 4，滿分 24，才能和重構前比較。派工單寫 1 到 5，改用 0 到 4 是為了前後可比。

## 採用的決定

- 評分尺度沿用基準的 0 到 4。
- 移交詳情的截圖資料：新增 demo 用的 `POST /api/demo/handover`（只在 Mock 模式存在，只寫記憶體 store），不動 migration 與種子 SQL。
- 全站截圖用同一支基準腳本，輸出位置由環境變數 `BASELINE_UI_DIR` 指定。`docs/ui/baseline/` 沒有被覆蓋。
- 委託管理精靈只拍步驟二與三，步驟四要先指派執業人員，不在這一票備資料。
- 設計樣式頁（35）是內部展示頁，有 2 顆 primary 按鈕是展示用，不算違規。


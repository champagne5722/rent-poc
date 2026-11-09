<!-- ste-lint: off -->
<!-- 模組說明給開發者與 agent 讀，內容是介面與接點清單，句長規則不適用 -->
# 委託標的清單與委託範圍（`src/lib/mandate-schedule/`）

MIL-74 的成果。依據：P0-11、ADR-0018、GLOSSARY「委託標的清單」「委託範圍」。範圍的四項、條文的假設與清單的形式都待法務確認（MIL-62）。

| 檔案 | 內容 | 純函式 |
|---|---|---|
| `index.ts` | `MANDATE_SCOPES`（收租、押金管理、修繕、點交）、`MandateItem`、`mandateItemFromProperty`、`mandateItemsIssues`、`mandateScopesOf`、`isScopeMandated`、`parseMandateSelection`、`resolveMandateItems` | 是，client 也能引用 |
| `repository.ts` | `getMandateItems(tx, contractId)`、`replaceMandateItems(tx, contractId, items)`、`copyMandateItems(tx, fromContractId, toContractId)`。表 `org.contract_mandate_items` 在 `db/migrations/0013_contract_mandate_items.sql` | |

## 資料

- 一個租賃單位一列。`property_id` 是文字，沒有外鍵：B 線完成後改指產權錨點，不是 `org.properties` 的 ULID。`contract_id` 是 `org.contracts.id`（ULID 文字），用複合外鍵 `(org_id, contract_id)` 參照。`scopes` 是 jsonb 陣列。
- 名稱與地址是加入清單當下的快照。`resolveMandateItems` 讓已存的列沿用原快照，只有新加的列才向物件取現況。
- 列的順序存在 `position`，PDF 附件頁與畫面照這個順序。
- 刪除草稿時清單一併刪除，靠外鍵的 `ON DELETE CASCADE`（`deleteDraftContract` 不用另外處理）。複製為新草稿時清單一併複製（copy route，同一個交易）。
- 第二次同步 main 時已搬進 PostgreSQL。三個 repository 函式第一個參數改成 `OrgTx`，`contractId` 改成 ULID 字串。

## 給 MIL-77、C 線 MIL-116

- 委託範圍的查詢：載入清單後用 `mandateScopesOf(items, propertyId)` 或 `isScopeMandated(items, propertyId, scope)`。D 線不限制受託人的動作，限制屬 C 線（P0-11 AC4）。
- 清單的 `propertyId` 現在是 `org.properties` 的 ULID。B 線完成後，把它換成產權錨點 ID，欄位型別不變。
- P0-11 AC3（清單有 3 個租賃單位時，3 個租賃案件各自連結此委託管理案件）屬 C 線。清單列就是案件的來源。

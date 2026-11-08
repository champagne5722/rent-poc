# 標籤對照表（`src/lib/labels/`）

介面與文件上的稱謂都從這裡取字。模組只有純函式與常數，不碰資料庫、不碰畫面。用詞以 `GLOSSARY.md` 的定義欄為準。

## 匯出

| 名稱 | 簽名 | 給誰用 |
|---|---|---|
| `partyLabels` | `(contractType: 'lease' \| 'management') => PartyLabels` | 合約 PDF 的簽署欄與條文、確認頁的簽署順序說明、合約詳情頁、修繕責任標籤 |
| `statutoryTitle` | `(licenseKind: LicenseKind \| LicenseKind[], businessType?: BusinessType) => string` | 合約 PDF 的甲方或受託人稱謂、承租人端的對方稱謂、標章、MIL-109 批次查詢、F 線屋主端畫面 |
| `practitionerTitle` | `(certificateKind: CertificateKind) => string` | 簽章欄的執業人員稱謂、經理人驗證畫面、審核佇列 |
| `TERMS` | 常數 | 需要單一詞（例如「出租人」）而非整組標籤的畫面 |
| `LEGACY_TERMS` | 常數 | 之後的舊用詞 lint 測試 |

## 規則

- `partyLabels`：租賃合約是甲方（出租人）、乙方（承租人）。委託管理合約是甲方（委託人）、乙方（受託人）。
- `statutoryTitle`：只有一種業別時，業務類型不影響稱謂。兼營時由案件的業務類型決定，`managed` 用代管業者，`master_lease` 用包租業者。兼營卻無法決定時拋 `RangeError`。傳入空陣列也拋 `RangeError`。
- `practitionerTitle`：`rental_housing_manager` 是租賃住宅管理人員，`real_estate_broker` 是不動產經紀人，`real_estate_sales_agent` 是不動產經紀營業員。
- `LEGACY_TERMS.everywhere` 是所有介面字串都禁用的舊用詞。`contractPdfAndLessee` 是合約 PDF、承租人端與標章另外禁用的「經理人」。`exemptPhrases` 是含禁用詞作為子字串的合法詞（「執業主體」含「業主」），掃描時必須先排除。

## 範圍外

畫面、確認頁、PDF、修繕責任與合約歷程的換字，以及 lint 測試，屬 MIL-122 的下一段。

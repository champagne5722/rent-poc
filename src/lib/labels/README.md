# 標籤對照表（`src/lib/labels/`）

介面與文件上的稱謂都從這裡取字。模組只有純函式與常數，不碰資料庫、不碰畫面。用詞以 `GLOSSARY.md` 的定義欄為準。

## 匯出

| 名稱 | 簽名 | 給誰用 |
|---|---|---|
| `partyLabels` | `(contractType: 'lease' \| 'management') => PartyLabels` | 合約 PDF 的簽署欄與條文、確認頁的簽署順序說明、合約詳情頁、修繕責任標籤 |
| `statutoryTitle` | `(licenseKind: LicenseKind \| LicenseKind[], businessType?: BusinessType) => string` | 合約 PDF 的甲方或受託人稱謂、承租人端的對方稱謂、標章、MIL-109 批次查詢、F 線屋主端畫面 |
| `practitionerTitle` | `(certificateKind: CertificateKind) => string` | 簽章欄的執業人員稱謂、經理人驗證畫面、審核佇列 |
| `TERMS` | 常數 | 需要單一詞（例如「出租人」）而非整組標籤的畫面 |
| `BUSINESS_TYPE_LABELS` | 常數 | 業務類型的畫面標籤：自管、代管、包租。建約 wizard 的分流條件使用 |
| `LEGACY_TERMS` | 常數 | 舊用詞 lint 測試（`legacy-terms.lint.test.ts`） |

## 規則

- `partyLabels`：租賃合約是甲方（出租人）、乙方（承租人）。委託管理合約是甲方（委託人）、乙方（受託人）。
- `statutoryTitle`：只有一種業別時，業務類型不影響稱謂。兼營時由案件的業務類型決定，`managed` 用代管業者，`master_lease` 用包租業者。兼營卻無法決定時拋 `RangeError`。傳入空陣列也拋 `RangeError`。
- `practitionerTitle`：`rental_housing_manager` 是租賃住宅管理人員，`real_estate_broker` 是不動產經紀人，`real_estate_sales_agent` 是不動產經紀營業員。
- `LEGACY_TERMS.everywhere` 是所有介面字串都禁用的舊用詞。`contractPdfAndLessee` 是合約 PDF、承租人端與標章另外禁用的「經理人」。`exemptPhrases` 是含禁用詞作為子字串的合法詞（「執業主體」含「業主」），掃描時必須先排除。

## 舊用詞 lint（MIL-122）

`legacy-scan.ts` 只供測試使用，依賴 `typescript` 編譯器，不是標籤模組的匯出，也不進執行期的 bundle。

`legacy-terms.lint.test.ts` 掃描 `src` 的 `.ts`、`.tsx`，只看字串字面值、樣板字串與 JSX 文字，用 `legacy-scan.ts` 的 `scanSource`。`LEGACY_TERMS.everywhere` 在所有檔案禁用。`contractPdfAndLessee`（經理人）只在合約 PDF、承租人端與標章的檔案禁用，路徑清單在 `legacy-scan.ts` 的 `MANAGER_BANNED_PATTERNS`。

例外：

- 程式註解與程式識別字（掃描器不看）。
- 測試檔（`*.test.ts`、`*.test.tsx`）。
- `LEGACY_TERMS` 本身。
- `exemptPhrases`（執業主體）。
- 字串所在行或上一行有 `legacy-term-ok: 理由` 的法條或法定文件名引用。

`pdf-legacy-terms.test.ts` 另從真的產出的 PDF 讀回全文，確認沒有任何舊用詞。

畫面要顯示甲乙方稱謂時，從 `partyLabels` 或 `TERMS` 取字，不要硬寫。識別字與資料庫欄位（`landlord`、`tenantName`）不改名，由 MIL-124 處理。

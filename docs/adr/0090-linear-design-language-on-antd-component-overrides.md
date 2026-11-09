---
status: accepted
---

# 以 antd 實現 Linear 設計語言：DESIGN.md 擴充到元件層，允許組合元件

使用者回報介面操作彆扭、元件樣式不一致。產品目標是重構後至少達到 Linear 介面的等級。ADR-0009 只把全域 token 映射到 antd，也接受「字階、精細間距做不到」的限制，並寫明要求更高精緻度時需重評。本 ADR 是那次重評。決議：保留 antd 與 `DESIGN.md` 單一來源，把 `DESIGN.md` 擴充到元件層，並允許只組合 antd 元件的組合元件。

## 決議內容

1. **保留 antd v6，不換元件庫。** 問題在資訊元件的選用與組合，不在框架。換元件庫要重寫全部頁面。

2. **`DESIGN.md` 擴充到元件層。** front matter 新增元件層 token，由 parser 映射到 `theme.components`。多級字階也加入 front matter。

   - antd token 做不到的視覺，例如字距，得寫在一份全域 CSS，數值仍必須來自 `DESIGN.md`。
   - 頁面程式碼不得寫死色碼、px 或 inline style。
   - 外觀的唯一來源仍是 `DESIGN.md`，ADR-0009 的 runtime 直讀機制不變。

3. **允許組合元件，自訂元件仍禁止。**

   - 組合元件只組合 antd 元件，不覆寫外觀。例如頁首、狀態標籤、空狀態、列表頁版型、詳情頁版型。
   - 自訂元件指自己畫外觀，或覆寫 antd 內部 class 的元件。這類元件仍然禁止。
   - 同一個狀態的顏色與名稱，全站必須只有一份定義。

4. **參考 repo 只取資訊元件的選用與組合。** 參考對象是 ant-design-pro、antd-admin、colony，三者都用 antd v6。

   - 這三個 repo 放在專案外，不加入依賴。
   - 不引入 pro-components、Umi、refine。它們在 antd 上面多包一層元件與樣式，外觀來源會和 `DESIGN.md` 分裂。

## Considered Options

- **維持 ADR-0009 的全域 token 映射**：改動最小。缺點是 antd 預設的密度與字階和 Linear 差距大，達不到產品目標。
- **引入 pro-components**：能直接取得 ProLayout、ProTable。缺點是多一層元件與樣式來源，違反單一來源。
- **換成 Tailwind 加 headless 元件**：最容易逼近 Linear 的外觀。缺點是要重寫全部頁面，也推翻 ADR-0001。

## Consequences

- `src/lib/design-theme.ts` 的 parser 必須支援元件層 token 與字階，並補測試。
- `DESIGN.md` 本文要新增組合元件清單與使用時機，並修改 Do's and Don'ts 的「不要自訂元件」。修改後寫明組合元件屬於允許範圍。
- 重構範圍只做桌機與亮色介面，不含鍵盤操作、手機版、深色模式與無障礙標準。

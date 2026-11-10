import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import noInlineStyle from "./eslint-rules/no-inline-style.mjs";
import inlineStyleBaseline from "./eslint-rules/inline-style-baseline.json" with { type: "json" };

// 既有檔案的 inline style 先列為警告（MIL-174）。npm run lint:inline-style 設 INLINE_STYLE_REPORT=1，
// 把基準內的違規逐處列成警告。平常的 npm run lint 不列，因為 --max-warnings=10 會被數百則警告擠爆。
const reportInlineStyle = process.env.INLINE_STYLE_REPORT === "1";
// files 的 glob 把 [ 當萬用字元，路徑裡的 [id] 要寫成 [[]id]
const escapeGlob = (path) => path.replaceAll("[", "[[]");

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 不屬於本專案的程式碼：agent skills 與 pdf.js worker
    ".claude/**",
    "public/pdf.worker.min.mjs",
  ]),
  // inline style（style 屬性）一律禁止（MIL-174、ADR-0090）。新增與改動的檔案必須是 0。
  // 既有檔案的違規記在 eslint-rules/inline-style-baseline.json，數量只降不升，隨頁面重構刪除條目。
  // 規則的說明在 eslint-rules/no-inline-style.mjs，用法在 docs/ui/composite-components.md。
  {
    files: ["src/**/*.{tsx,jsx}"],
    plugins: { rent: { rules: { "no-inline-style": noInlineStyle } } },
    rules: { "rent/no-inline-style": "error" },
  },
  ...Object.entries(inlineStyleBaseline).map(([path, count]) => ({
    files: [escapeGlob(path)],
    rules: {
      "rent/no-inline-style": reportInlineStyle ? ["warn", { allow: 0 }] : ["error", { allow: count }],
    },
  })),
  // 型別感知的規則（MIL-80，ADR-0012 決議 14）：漏寫 await 時 tsc 不一定報錯，這兩條補上。
  // 需要 projectService，所以只套用在 src 的 TypeScript 檔案。
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  // 新規則的既有違規（MIL-80 開規則時量到：no-floating-promises 14 處、no-misused-promises 22 處）。
  // 全部在前端 client component 的 fetch 與事件處理，route handler 與 src/lib 沒有。
  // 這張票只列清單，不清。後續票逐檔修掉後，把該檔從下面移除。清單與逐檔數量在 MIL-80 的留言。
  // 不得整體關掉這兩條規則，新檔案一律受規則約束。
  {
    files: [
      "src/app/contracts/[[]id]/page.tsx", // floating 4、misused 12
      "src/app/contracts/new/page.tsx", // floating 1、misused 1
      "src/app/contracts/page.tsx", // floating 1、misused 2
      "src/app/page.tsx", // floating 1
      "src/app/properties/page.tsx", // floating 5、misused 4
      "src/components/ContractWizard.tsx", // floating 1、misused 3
      "src/components/SignatureFieldEditor.tsx", // floating 1
    ],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
    },
  },
  // 回應與交易的寫法限制（MIL-80）。
  // 1. Response.json 的參數型別是 any，Promise 會被序列化成 {}。一律走 src/lib/http.ts 的 jsonOk、jsonError。
  // 2. withTx 的 callback 內不得有外部 API 呼叫與計時器：交易佔著連線，外部呼叫一慢連線池就被耗盡
  //    （ADR-0012 決議 10）。這裡只擋最直接的寫法。經由別的函式間接呼叫抓不到，靠 review。
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/http.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name='json'][callee.object.name=/^(Response|NextResponse)$/]",
          message: "不得直接用 Response.json：改用 src/lib/http.ts 的 jsonOk 或 jsonError，漏寫 await 時 tsc 才會報錯。",
        },
        {
          selector:
            "CallExpression[callee.name='withTx'] CallExpression[callee.name=/^(fetch|setTimeout|setInterval|setImmediate)$/]",
          message: "withTx 的 callback 內不得呼叫外部 API 或計時器。外部呼叫改寫 outbox，提交後再派送。",
        },
        {
          selector:
            "CallExpression[callee.name='withTx'] CallExpression:matches([callee.object.name=/^(fs|fsp)$/], [callee.object.object.name=/^(fs|fsp)$/])",
          message: "withTx 的 callback 內不得做 fs 操作。檔案存取放在交易之外。",
        },
      ],
    },
  },
  // 既有違規：CI 接上 eslint 時已存在，暫時降為 warning，修掉後刪除這段。
  // 只限這 3 個檔案，其他檔案的同類違規仍是 error，CI 會擋下。
  {
    files: [
      "src/app/contracts/[[]id]/page.tsx",
      "src/app/properties/page.tsx",
      "src/components/SignatureFieldEditor.tsx",
    ],
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
    },
  },
]);

export default eslintConfig;

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

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

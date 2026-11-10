// 擋下 JSX 的 style 屬性（MIL-174、ADR-0090）。外觀只來自 DESIGN.md：
// 版面用 antd 的 Flex、Space、Row 與 CSS Modules，顏色與間距引用 CSS 變數，不寫 inline style。
//
// 選項 allow：這個檔案既有的 inline style 數量（基準）。
// - 違規數不超過 allow：不回報。既有檔案先不擋，隨頁面重構清除。
// - 違規數超過 allow：超出的那幾處回報。新增 inline style 一律被擋。
// - 違規數少於 allow：回報一則訊息，要求把基準降到實際數量或刪除條目。基準只降不升。
// 沒有 allow（預設 0）的檔案，任何 style 屬性都回報。
// 基準寫在 eslint-rules/inline-style-baseline.json，由 eslint.config.mjs 逐檔帶入。

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: '禁止 JSX 的 style 屬性（inline style）' },
    schema: [
      {
        type: 'object',
        properties: { allow: { type: 'integer', minimum: 0 } },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const allow = context.options[0]?.allow ?? 0;
    /** @type {import('estree').Node[]} */
    const found = [];
    return {
      JSXAttribute(node) {
        if (node.name.type === 'JSXIdentifier' && node.name.name === 'style') found.push(node);
      },
      'Program:exit'(program) {
        for (const node of found.slice(allow)) {
          context.report({
            node,
            message:
              'inline style 不得新增（ADR-0090）。版面用 antd 的 Flex、Space 或 CSS Modules，數值引用 DESIGN.md 的 CSS 變數。',
          });
        }
        if (found.length < allow) {
          context.report({
            node: program,
            message: `這個檔案的 inline style 從 ${allow} 處降到 ${found.length} 處。請在 eslint-rules/inline-style-baseline.json 把它的基準改成 ${found.length}，降到 0 就刪除條目。`,
          });
        }
      },
    };
  },
};

export default rule;

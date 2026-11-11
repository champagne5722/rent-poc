// 擋下 JSX 的 style 屬性（MIL-174、ADR-0090）。外觀只來自 DESIGN.md：
// 版面用 antd 的 Flex、Space、Row 與 CSS Modules，顏色與間距引用 CSS 變數，不寫 inline style。
//
// 選項 allow：這個檔案容許的 inline style 數量，預設 0，任何 style 屬性都回報。
// MIL-185 起範圍內的檔案都是 0，沒有檔案使用 allow。承租人端與 demo 頁由 eslint.config.mjs 排除。

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
            message: `這個檔案的 inline style 從 ${allow} 處降到 ${found.length} 處。請把 allow 改成 ${found.length}，降到 0 就刪除該選項。`,
          });
        }
      },
    };
  },
};

export default rule;

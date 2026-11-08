// 舊用詞掃描器（MIL-122）：從原始碼抽出介面字串，找出 LEGACY_TERMS 的禁用詞。
// 只看字串字面值、樣板字串與 JSX 文字。註解、識別字不是字串節點，所以不會被掃到。
// 供 legacy-terms.lint.test.ts 使用，不進執行期的 bundle。

import ts from 'typescript';
import { LEGACY_TERMS } from './index';

/** 字串所在行或上一行有這個標記時略過，用在引用法條或法定文件名的字串，標記後寫理由。 */
export const LEGACY_OK_MARKER = 'legacy-term-ok:';

export interface LegacyHit {
  file: string;
  line: number;
  term: string;
  text: string;
}

/**
 * 「經理人」另外禁用的檔案：合約 PDF、承租人端與標章（MIL-122 AC7）。
 * 路徑以 repo 為根、用正斜線。
 */
const MANAGER_BANNED_PATTERNS: readonly RegExp[] = [
  /^src\/lib\/pdf[^/]*\.ts$/,
  /^src\/lib\/contract-clauses\.ts$/,
  /^src\/lib\/clause-library\.ts$/,
  /^src\/app\/api\/contracts\/\[id\]\/pdf\//,
  /^src\/app\/lessee\//,
  /^src\/components\/lessee\//,
  /^src\/lib\/registry-rules\/exclusivity\.ts$/,
];

export function bannedTermsFor(file: string): string[] {
  const terms: string[] = [...LEGACY_TERMS.everywhere];
  if (MANAGER_BANNED_PATTERNS.some((p) => p.test(file))) terms.push(...LEGACY_TERMS.contractPdfAndLessee);
  return terms;
}

function stripExempt(text: string): string {
  let out = text;
  for (const phrase of LEGACY_TERMS.exemptPhrases) out = out.split(phrase).join('');
  return out;
}

/** 掃一份原始碼。file 用來決定適用哪組禁用詞，也寫進結果。 */
export function scanSource(file: string, source: string): LegacyHit[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const lines = source.split('\n');
  const terms = bannedTermsFor(file);
  const hits: LegacyHit[] = [];

  const marked = (line: number) =>
    lines[line]?.includes(LEGACY_OK_MARKER) || lines[line - 1]?.includes(LEGACY_OK_MARKER);

  const check = (node: ts.Node, text: string) => {
    const cleaned = stripExempt(text);
    const start = node.getStart(sf);
    const line = sf.getLineAndCharacterOfPosition(start).line;
    if (marked(line)) return;
    for (const term of terms) {
      if (cleaned.includes(term)) hits.push({ file, line: line + 1, term, text: text.trim().slice(0, 60) });
    }
  };

  const visit = (node: ts.Node) => {
    // LEGACY_TERMS 本身列出禁用詞，不掃。
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'LEGACY_TERMS') return;
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      check(node, node.text);
    } else if (ts.isJsxText(node)) {
      check(node, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

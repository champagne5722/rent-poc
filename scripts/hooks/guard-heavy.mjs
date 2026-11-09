// PreToolUse hook（matcher: Bash）：擋下沒有經過記憶體排程的重命令（MIL-166）。
//
// 為什麼：開發機只有 16 GB。多個子對話同時執行 vitest、eslint、tsc、next dev、next build 會用完記憶體。
// 規則：命令串中任何一段直接執行這五種工具就擋下，並在訊息裡寫出正確的命令。
// 不擋：經 scripts/heavy.sh 或 verify.sh 的命令、npm script，以及只是提到這些字的命令。
//
// 這是防呆，不是安全邊界。下列寫法不分析，會放行：
// - 雙引號內的 $(...) 與反引號
// - 變數展開出來的命令（例如 $CMD）
// - xargs、find -exec 等由別的程式組出來的命令
//
// 輸入：標準輸入的 JSON（tool_name、tool_input.command）。
// 輸出：要擋時結束碼 2 加 stderr 訊息（Claude Code 會把 stderr 交給模型）。其他情況結束碼 0。
// CI=true 時一律放行，與 heavy.sh 的行為一致。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HEAVY_WRAPPERS = new Set(['heavy.sh', 'verify.sh']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
// 這些前綴命令只是包著後面的命令，判斷時剝掉。
const PREFIXES = new Set(['time', 'nice', 'env', 'command', 'exec', 'nohup', 'timeout', 'caffeinate', 'stdbuf']);
const NODE_MODULE_TOOLS = { vitest: 'vitest', eslint: 'eslint', typescript: 'tsc', next: 'next' };

const MESSAGES = {
  vitest: '改用 `npm test`。指定檔案時用 `npm test -- <路徑>`。',
  eslint: '改用 `npm run lint`。',
  tsc: '改用 `npm run typecheck`。',
  'next build': '改用 `npm run build:local`。',
  'next dev':
    '把啟動 dev server、跑冒煙、關閉 dev server 寫在同一個腳本，用 `scripts/heavy.sh smoke scripts/smoke/run-smoke.sh <port> <冒煙腳本>` 執行。做法見 docs/agents/implementing.md。',
};

/**
 * 把 shell 命令字串切成段落，每段是一串去掉引號的單字。
 * 處理單雙引號、反斜線、註解、heredoc，以及 && || ; | & 換行 ( ) 反引號 $( 這些分隔符。
 * @param {string} input
 * @returns {string[][]}
 */
export function splitSegments(input) {
  const segments = [];
  let words = [];
  let word = null; // null 表示目前沒有在組單字
  const heredocs = []; // 等到下一個換行時要略過內容的 heredoc 結尾字
  let i = 0;

  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };
  const append = (ch) => {
    word = (word ?? '') + ch;
  };

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    if (ch === '\\') {
      if (next === '\n') {
        i += 2; // 行尾接續
      } else {
        if (next !== undefined) append(next);
        i += 2;
      }
      continue;
    }
    if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      const stop = end === -1 ? input.length : end;
      append(input.slice(i + 1, stop));
      word ??= '';
      i = stop + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let text = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          text += input[j + 1];
          j += 2;
        } else {
          text += input[j];
          j += 1;
        }
      }
      append(text);
      word ??= '';
      i = j + 1;
      continue;
    }
    if (ch === '#' && word === null) {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '\n') {
      endSegment();
      i += 1;
      // 略過 heredoc 內容，直到只含結尾字的那一行
      while (heredocs.length > 0) {
        const { delimiter, stripTabs } = heredocs.shift();
        while (i < input.length) {
          let eol = input.indexOf('\n', i);
          if (eol === -1) eol = input.length;
          let line = input.slice(i, eol);
          if (stripTabs) line = line.replace(/^\t+/, '');
          i = Math.min(eol + 1, input.length);
          if (line === delimiter) break;
        }
      }
      continue;
    }
    if (ch === '<' && next === '<' && input[i + 2] !== '<') {
      let j = i + 2;
      let stripTabs = false;
      if (input[j] === '-') {
        stripTabs = true;
        j += 1;
      }
      while (input[j] === ' ' || input[j] === '\t') j += 1;
      let delimiter = '';
      const quote = input[j] === "'" || input[j] === '"' ? input[j] : null;
      if (quote) j += 1;
      while (j < input.length && !/[\s;&|()<>]/.test(input[j]) && input[j] !== quote) {
        delimiter += input[j];
        j += 1;
      }
      if (quote && input[j] === quote) j += 1;
      if (delimiter) heredocs.push({ delimiter, stripTabs });
      endWord();
      i = j;
      continue;
    }
    if (ch === '&') {
      if (next === '&') {
        endSegment();
        i += 2;
        continue;
      }
      const prev = input[i - 1];
      if (prev === '>' || prev === '<' || next === '>') {
        append(ch); // 2>&1、&>file
        i += 1;
        continue;
      }
      endSegment();
      i += 1;
      continue;
    }
    if (ch === '|') {
      endSegment();
      i += next === '|' ? 2 : 1;
      continue;
    }
    if (ch === ';' || ch === '(' || ch === ')' || ch === '`') {
      endSegment();
      i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      endWord();
      i += 1;
      continue;
    }
    append(ch);
    i += 1;
  }
  endSegment();
  return segments;
}

const isAssignment = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);

/** 剝掉開頭的環境變數指定與 time、nice、env 這類前綴命令。 */
function stripPrefixes(words) {
  let w = [...words];
  for (;;) {
    while (w.length > 0 && isAssignment(w[0])) w = w.slice(1);
    if (w.length === 0 || !PREFIXES.has(w[0])) return w;
    const prefix = w[0];
    w = w.slice(1);
    if (prefix === 'nice' && w[0] === '-n') w = w.slice(2);
    else if (prefix === 'timeout') {
      while (w.length > 0 && w[0].startsWith('-')) w = w.slice(1);
      if (w.length > 0 && /^\d/.test(w[0])) w = w.slice(1);
    } else {
      while (w.length > 0 && w[0].startsWith('-')) w = w.slice(1);
    }
  }
}

/** 取得 npx、npm exec 這類命令要執行的套件與它的參數。 */
function packageToRun(words) {
  let w = words;
  while (w.length > 0 && w[0].startsWith('-')) {
    // -p、--package 後面接套件名
    w = w[0] === '-p' || w[0] === '--package' ? w.slice(2) : w.slice(1);
  }
  if (w.length === 0) return null;
  const name = w[0].replace(/(?<=.)@[^/@]*$/, ''); // vitest@latest -> vitest
  return { tool: path.basename(name), args: w.slice(1) };
}

/** 回傳這一段執行的 { tool, args }，不需要檢查的段落回傳 null。 */
function resolveTool(words) {
  const w = stripPrefixes(words);
  if (w.length === 0) return null;
  const head = path.basename(w[0]);
  if (HEAVY_WRAPPERS.has(head)) return null;

  if (head === 'npx' || head === 'bunx') return packageToRun(w.slice(1));
  if ((head === 'npm' || head === 'pnpm' || head === 'yarn' || head === 'bun') && ['exec', 'dlx', 'x'].includes(w[1] ?? '')) {
    return packageToRun(w.slice(2));
  }
  if (head === 'node') {
    const script = w.slice(1).find((a) => !a.startsWith('-'));
    const m = script?.match(/node_modules\/(?:\.bin\/)?(vitest|eslint|typescript|next)(?:\/|$)/);
    return m ? { tool: NODE_MODULE_TOOLS[m[1]], args: w.slice(2) } : null;
  }
  return { tool: head, args: w.slice(1) };
}

/** 這一段是重命令時回傳 { key, command }，否則回傳 null。 */
function classify(words) {
  const w = stripPrefixes(words);
  const head = w.length > 0 ? path.basename(w[0]) : '';

  if (SHELLS.has(head)) {
    // bash -c "..." 要看引號內的命令。bash scripts/heavy.sh 之類的腳本不檢查。
    const flagIndex = w.findIndex((a, idx) => idx > 0 && /^-[a-z]*c[a-z]*$/.test(a));
    if (flagIndex === -1 || flagIndex + 1 >= w.length) return null;
    const inner = decide(w[flagIndex + 1]);
    return inner.block ? { key: inner.key, command: inner.command } : null;
  }

  const resolved = resolveTool(words);
  if (!resolved) return null;
  const { tool, args } = resolved;
  const command = words.join(' ');
  if (tool === 'vitest') return { key: 'vitest', command };
  if (tool === 'eslint') return { key: 'eslint', command };
  if (tool === 'tsc') return { key: 'tsc', command };
  if (tool === 'next') {
    const sub = args.find((a) => !a.startsWith('-'));
    if (sub === 'dev') return { key: 'next dev', command };
    if (sub === 'build') return { key: 'next build', command };
  }
  return null;
}

/**
 * 判斷一個 Bash 命令字串要不要擋。
 * @param {string} command
 * @returns {{ block: false } | { block: true, key: string, command: string, message: string }}
 */
export function decide(command) {
  for (const words of splitSegments(command ?? '')) {
    const hit = classify(words);
    if (hit) {
      const message = [
        `被擋下：「${hit.command}」直接執行會繞過記憶體排程。`,
        MESSAGES[hit.key],
        '其他吃記憶體的命令，用 `scripts/heavy.sh <標籤> <命令>` 執行。回傳 75 代表排隊逾時，稍後再試。',
      ].join('\n');
      return { block: true, key: hit.key, command: hit.command, message };
    }
  }
  return { block: false };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  if (process.env.CI === 'true') return 0;
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return 0;
  }
  if (payload?.tool_name !== 'Bash') return 0;
  const command = payload?.tool_input?.command;
  if (typeof command !== 'string') return 0;
  const result = decide(command);
  if (!result.block) return 0;
  process.stderr.write(`${result.message}\n`);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

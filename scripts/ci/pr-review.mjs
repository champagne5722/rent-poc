// PR 自動審查（MIL-215）。由 .github/workflows/pr-review.yml 呼叫。
//
// 做什麼：讀 PR 的標題、本文與 diff，加上 repo 的標準文件，呼叫一次 Messages API，
// 把 Standards、Spec、安全三面的審查結果貼成 PR 上的一則留言。重跑時更新同一則。
//
// 安全規則：
// - 沒有金鑰、額度用完、金鑰失效或任何其他錯誤，都以結束碼 0 離開，不讓 PR 的檢查變紅。
// - 腳本、提示詞與依據文件來自 base 分支的 checkout（TRUSTED_DIR），不執行 PR 裡的任何腳本。
// - diff 與 PR 本文只當資料送給模型。這支腳本不會把它們當程式碼執行。
// - 金鑰只從環境變數 ANTHROPIC_API_KEY 讀取，不寫進 log 與留言。
//
// 環境變數：見 docs/agents/pr-review.md。
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ReviewParseError,
  buildRequest,
  buildSystemText,
  buildUserText,
  classifyError,
  effectiveInputBudget,
  estimateCost,
  extractAvoidTerms,
  findReviewComment,
  gate,
  hasAcceptanceSection,
  limitsFromEnv,
  parseReview,
  redact,
  renderRetainedReview,
  renderReview,
  renderSkip,
  isReviewBody,
  selectDiff,
} from './pr-review-core.mjs';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_EFFORT = 'medium';
const PROMPT_FILE = '.github/pr-review-prompt.md';
const CONTEXT_FILES = ['AGENTS.md', 'docs/agents/implementing.md'];
const MAX_DOC_CHARS = 60_000;
const COUNT_ATTEMPTS = 3;

/**
 * 審查一張 PR。所有外部依賴都從 deps 注入，方便用假物件測試。
 *   env           環境變數物件
 *   github        { getPull, listComments, createComment, updateComment }
 *   createClient  (apiKey) => 有 messages.create 與 messages.countTokens 的物件
 *   readTrusted   (相對路徑) => 字串或 null。讀 base 分支的檔
 *   getDiff       () => 字串。PR 的 unified diff
 *   writeSummary  (文字) => void。寫入工作摘要
 *   log           (一行文字) => void
 */
export async function runReview(deps) {
  const { env, github, createClient, readTrusted, getDiff, log = console.log, writeSummary = () => {}, nonce = randomBytes(6).toString('hex') } = deps;

  const apiKey = (env.ANTHROPIC_API_KEY ?? '').trim();
  if (!apiKey) {
    log('沒有設定金鑰，略過審查');
    return { status: 'no-key' };
  }
  const number = Number(env.PR_NUMBER);
  if (!Number.isInteger(number) || number <= 0) {
    log('::warning::PR_NUMBER 無效，略過審查');
    return { status: 'bad-input' };
  }
  const model = (env.REVIEW_MODEL ?? '').trim() || DEFAULT_MODEL;
  const effort = (env.REVIEW_EFFORT ?? '').trim() || DEFAULT_EFFORT;
  const limits = limitsFromEnv(env);

  let pr;
  try {
    pr = await github.getPull(number);
  } catch (err) {
    log(`::warning::讀取 PR 失敗，略過審查。${classifyError(err).detail}`);
    return { status: 'github-error' };
  }
  const decision = gate({ pr, repo: env.GITHUB_REPOSITORY });
  if (!decision.run) {
    log(`略過審查：${decision.reason}`);
    return { status: 'gated', reason: decision.reason };
  }
  const sha = pr.head?.sha;

  const promptText = readTrusted(PROMPT_FILE);
  if (!promptText) {
    log(`base 分支沒有 ${PROMPT_FILE}，略過審查`);
    return { status: 'no-prompt' };
  }

  // body 可以是字串，或是收到既有留言本文（沒有時為 null）後回傳新本文的函式。
  const postComment = async (summary, body) => {
    writeSummary(summary);
    try {
      await upsertComment(github, number, body);
    } catch (err) {
      log(`::warning::寫入 PR 留言失敗。${classifyError(err).detail}`);
    }
  };
  const skip = async ({ reason, detail, kind }) => {
    log(`::warning::這次沒有審查（${kind}）：${reason}。${detail ?? ''}`);
    const skipBody = renderSkip({ reason, detail, model, sha });
    // PR 上已有有效的審查時，保留它，只在開頭說明最近一次為什麼沒有審查。
    await postComment(skipBody, (existingBody) => (isReviewBody(existingBody) ? renderRetainedReview(existingBody, { reason, sha }) : skipBody));
    return { status: 'skipped', kind };
  };

  try {
    const docs = CONTEXT_FILES.map((p) => ({ path: p, text: (readTrusted(p) ?? '').slice(0, MAX_DOC_CHARS) })).filter((d) => d.text);
    const glossaryAvoid = extractAvoidTerms(readTrusted('GLOSSARY.md') ?? '');
    const systemText = buildSystemText({ promptText, docs, glossaryAvoid });
    const diffText = getDiff();
    if (!diffText.trim()) {
      log('略過審查：PR 沒有 diff');
      return { status: 'empty-diff' };
    }
    const hasAcceptance = hasAcceptanceSection(pr.body);
    const client = await createClient(apiKey);
    const { maxInputTokens, costCapApplied } = effectiveInputBudget(model, limits);

    // 先用免費的 count_tokens 量輸入長度，超過上限就縮小 diff 再量。最多量 3 次。
    let diffBudget = limits.maxDiffChars;
    let selection;
    let request;
    let inputTokens = Infinity;
    for (let attempt = 0; attempt < COUNT_ATTEMPTS; attempt += 1) {
      selection = selectDiff(diffText, { maxDiffChars: diffBudget, maxFileDiffChars: limits.maxFileDiffChars });
      const userText = buildUserText({ title: pr.title ?? '', body: pr.body ?? '', diff: selection.text, omitted: selection.omitted, nonce, hasAcceptance });
      request = buildRequest({ model, effort, maxOutputTokens: limits.maxOutputTokens, systemText, userText });
      inputTokens = await countInputTokens(client, request, systemText.length + userText.length);
      if (inputTokens <= maxInputTokens) break;
      diffBudget = Math.floor(Math.min(diffBudget, selection.text.length) * (maxInputTokens / inputTokens) * 0.9);
      if (diffBudget < 2000) break;
    }
    if (inputTokens > maxInputTokens) {
      return await skip({ kind: 'too_large', reason: `輸入超過上限 ${maxInputTokens} token，縮小 diff 後仍放不下`, detail: `量到 ${inputTokens} token` });
    }

    const response = await client.messages.create(request);
    if (response.stop_reason === 'refusal') {
      return await skip({ kind: 'refusal', reason: '模型拒絕這次審查', detail: `stop_reason refusal，類別 ${response.stop_details?.category ?? '未知'}` });
    }
    if (response.stop_reason === 'max_tokens') {
      return await skip({ kind: 'max_tokens', reason: `輸出超過上限 ${limits.maxOutputTokens} token，結果被截斷`, detail: `用量 ${response.usage?.output_tokens ?? '未知'} token` });
    }
    const text = (response.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const review = parseReview(text);
    const cost = estimateCost(model, response.usage);
    const body = renderReview(review, { model, effort, usage: response.usage, cost, sha, limits, selection, hasAcceptance, costCapApplied });
    await postComment(body, body);
    log(`審查完成：${body.split('\n')[1]}，估計費用 ${cost === null ? '未知' : cost.toFixed(4)} 美元`);
    return { status: 'reviewed', conclusion: body.split('\n')[1], cost };
  } catch (err) {
    if (err instanceof ReviewParseError) return await skip({ kind: 'parse', reason: err.message, detail: '' });
    const c = classifyError(err);
    return await skip(c);
  }
}

/** 量輸入 token。額度或驗證錯誤照丟（呼叫端會處理）。其他錯誤改用保守估計，不因此放棄審查。 */
async function countInputTokens(client, request, charCount) {
  try {
    const res = await client.messages.countTokens({ model: request.model, system: request.system, messages: request.messages });
    if (Number.isFinite(res?.input_tokens)) return res.input_tokens;
  } catch (err) {
    const kind = classifyError(err).kind;
    if (kind === 'credit' || kind === 'auth') throw err;
  }
  return Math.ceil(charCount / 2);
}

/**
 * 找到帶標記、作者 login 是 github-actions[bot] 的留言就更新，沒有就新增。
 * body 可以是字串，或是收到既有留言本文（沒有時為 null）後回傳新本文的函式。
 */
export async function upsertComment(github, number, body) {
  const comments = await github.listComments(number);
  const existing = findReviewComment(comments);
  const text = typeof body === 'function' ? body(existing ? existing.body : null) : body;
  if (existing) await github.updateComment(existing.id, text);
  else await github.createComment(number, text);
}

// ---------------------------------------------------------------------------
// 真實的依賴

/** 用 fetch 呼叫 GitHub REST。token 只放在標頭。 */
export function createGithubClient({ token, repo, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  async function call(method, route, body) {
    const res = await fetchImpl(`${apiUrl}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'rent-poc-pr-review',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = new Error(`GitHub API ${method} ${route} 回傳 ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }
  return {
    getPull: (n) => call('GET', `/repos/${repo}/pulls/${n}`),
    async listComments(n) {
      const all = [];
      for (let page = 1; page <= 20; page += 1) {
        const batch = await call('GET', `/repos/${repo}/issues/${n}/comments?per_page=100&page=${page}`);
        all.push(...batch);
        if (batch.length < 100) break;
      }
      return all;
    },
    createComment: (n, body) => call('POST', `/repos/${repo}/issues/${n}/comments`, { body }),
    updateComment: (id, body) => call('PATCH', `/repos/${repo}/issues/comments/${id}`, { body }),
  };
}

/** 從 review-deps 載入官方 SDK。workflow 先用 npm ci 安裝。 */
async function defaultCreateClient(apiKey) {
  const url = new URL('./review-deps/node_modules/@anthropic-ai/sdk/index.mjs', import.meta.url);
  const mod = await import(url.href);
  const Anthropic = mod.default ?? mod.Anthropic;
  return new Anthropic({ apiKey, maxRetries: 2, timeout: 5 * 60 * 1000 });
}

async function main() {
  const env = process.env;
  const trustedDir = path.resolve(env.TRUSTED_DIR || '.');
  const prDir = path.resolve(env.PR_DIR || '.');
  const readTrusted = (rel) => {
    try {
      return readFileSync(path.join(trustedDir, rel), 'utf8');
    } catch {
      return null;
    }
  };
  const getDiff = () =>
    // 合併 commit 的第一個父代是 base。只看 PR 帶來的變更。引數用陣列傳，不經過 shell。
    execFileSync('git', ['-C', prDir, '-c', 'core.quotepath=false', 'diff', '-U20', '--no-color', '--no-ext-diff', '--no-textconv', 'HEAD^1', 'HEAD'], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  const writeSummary = (text) => {
    if (env.GITHUB_STEP_SUMMARY) {
      try {
        appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
      } catch {
        // 摘要寫不進去不影響審查。
      }
    }
  };
  const github = createGithubClient({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY, apiUrl: env.GITHUB_API_URL || undefined });
  await runReview({ env, github, createClient: defaultCreateClient, readTrusted, getDiff, writeSummary });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    // 任何錯誤都不能讓 CI 變紅。
    console.log(`::warning::PR 審查腳本發生未預期的錯誤，已略過。${redact(classifyError(err).detail)}`);
  });
}

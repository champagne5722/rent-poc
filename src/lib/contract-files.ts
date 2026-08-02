import fs from 'fs';
import path from 'path';
import { DATA_DIR, getContractFile, upsertContractFile } from './db';
import { dsGetJson, isMockMode } from './dottedsign';
import { generateContractPdf } from './pdf';
import { CONTRACT_FILE_KINDS, CONTRACT_FILE_LABELS } from './types';
import type { Contract, ContractFile, ContractFileKind } from './types';

// 合約完成時保存的兩份文件（規格第 9 節、docs/research/dottedsign-signing-history.md 第 3 節）：
// 已簽 PDF（點點簽 file_types[]=task）與 Audit Trail File（file_types[]=audit_trail），
// 兩者都用 sign_tasks.download.read scope 的 /v1/sign_tasks/download_link 取得預簽連結後下載。
// 檔案本體落地在 data/contract-files/<合約 id>/ 下（data/ 已在 .gitignore），DB 只記檔案資訊。

const FILES_ROOT = 'contract-files';

// 內部 kind → 點點簽 file_types[] 值
const DS_FILE_TYPES: Record<ContractFileKind, string> = {
  signed_pdf: 'task',
  audit_trail: 'audit_trail',
};

export function dsFileType(kind: ContractFileKind): string {
  return DS_FILE_TYPES[kind];
}

// ⚠️ 官方 reference 的參數名就是 `file_types[]`（下載端點實測可用方括號，
// 與 share_link 的 task_ids 不同，見 docs/dottedsign-integration.md）
export function buildDownloadLinkPath(taskId: string, kinds: readonly ContractFileKind[]): string {
  const types = kinds.map((k) => `&file_types[]=${dsFileType(k)}`).join('');
  return `/v1/sign_tasks/download_link?task_id=${encodeURIComponent(taskId)}${types}`;
}

// 回應形狀：{ data: { task: "<S3 預簽連結>", audit_trail: "..." } }，key 對應 file_types[] 的值
export function pickDownloadLinks(
  json: unknown,
  kinds: readonly ContractFileKind[]
): Partial<Record<ContractFileKind, string>> {
  const data = (json as { data?: Record<string, unknown> } | null)?.data;
  if (!data || typeof data !== 'object') return {};
  const links: Partial<Record<ContractFileKind, string>> = {};
  for (const kind of kinds) {
    const link = data[dsFileType(kind)];
    if (typeof link === 'string' && link) links[kind] = link;
  }
  return links;
}

export function contractFileName(contractId: number, kind: ContractFileKind): string {
  const suffix = kind === 'signed_pdf' ? 'signed' : 'audit-trail';
  return `contract-${contractId}-${suffix}.pdf`;
}

// 相對 data/ 的路徑，DB 存這個值（不存絕對路徑，換機器仍可用）
export function contractFileRelPath(contractId: number, kind: ContractFileKind): string {
  return `${FILES_ROOT}/${contractId}/${contractFileName(contractId, kind)}`;
}

export function contractFileAbsPath(relPath: string): string {
  return path.join(DATA_DIR, relPath);
}

export type DownloadCheck = { ok: true } | { ok: false; status: number; error: string };

// 下載閘門：兩份文件都只在合約已完成後存在（未完成一律 4xx 並說明原因）
export function checkContractFileDownloadable(
  contract: Contract,
  kind: ContractFileKind,
  opts: { mock: boolean }
): DownloadCheck {
  const label = CONTRACT_FILE_LABELS[kind];
  if (contract.status !== 'completed') {
    return { ok: false, status: 409, error: `合約尚未完成簽署，${label}尚未產生` };
  }
  if (opts.mock) {
    // mock 模式沒有真實簽署任務：已簽 PDF 用未簽版充當示意，稽核文件則無從產生
    if (kind === 'audit_trail') {
      return { ok: false, status: 409, error: `mock 模式沒有真實簽署任務，無法提供${label}` };
    }
    return { ok: true };
  }
  if (!contract.dottedsign_task_id) {
    return { ok: false, status: 409, error: `合約沒有對應的簽署任務，無法取得${label}` };
  }
  return { ok: true };
}

// 已完成合約在這個模式下應該保存哪幾種檔案（mock 模式沒有稽核文件）
export function kindsToSave(opts: { mock: boolean }): ContractFileKind[] {
  return opts.mock ? ['signed_pdf'] : [...CONTRACT_FILE_KINDS];
}

export interface SaveFileResult {
  kind: ContractFileKind;
  ok: boolean;
  error?: string;
}

// 完成轉移之後呼叫：外部 IO，刻意放在狀態轉移的交易之外。
// 失敗不回滾合約狀態，只把錯誤記進 contract_files 供補抓（POST /api/contracts/[id]/files）。
export async function saveContractFiles(
  contract: Contract,
  opts?: { force?: boolean; only?: readonly ContractFileKind[] }
): Promise<SaveFileResult[]> {
  const mock = isMockMode();
  const kinds = kindsToSave({ mock })
    .filter((kind) => !opts?.only || opts.only.includes(kind))
    .filter((kind) => opts?.force || !isSaved(contract.id, kind));
  if (kinds.length === 0) return [];

  if (mock) {
    return [await saveMockSignedPdf(contract)];
  }

  const taskId = contract.dottedsign_task_id;
  if (!taskId) return kinds.map((kind) => recordFailure(contract.id, kind, '合約沒有對應的簽署任務'));

  let links: Partial<Record<ContractFileKind, string>>;
  try {
    const json = await dsGetJson(buildDownloadLinkPath(taskId, kinds));
    links = pickDownloadLinks(json, kinds);
  } catch (e) {
    const message = errorMessage(e);
    return kinds.map((kind) => recordFailure(contract.id, kind, message));
  }

  const results: SaveFileResult[] = [];
  for (const kind of kinds) {
    const link = links[kind];
    if (!link) {
      results.push(recordFailure(contract.id, kind, `點點簽未回傳${CONTRACT_FILE_LABELS[kind]}的下載連結`));
      continue;
    }
    try {
      // 預簽連結 15 分鐘失效且會 302 轉址，fetch 預設跟隨
      const res = await fetch(link);
      if (!res.ok) throw new Error(`下載連結回應 ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      writeContractFile(contract.id, kind, bytes, res.headers.get('content-type'));
      results.push({ kind, ok: true });
    } catch (e) {
      results.push(recordFailure(contract.id, kind, errorMessage(e)));
    }
  }
  return results;
}

// 完成轉移後的保存掛點。刻意不讓例外往外拋：webhook 回非 2xx 會被點點簽重試，
// 單日累積 10 次投遞失敗會停掉整個 application 的 webhook（見研究筆記第 1 節）。
// 抓檔失敗只記錄，狀態不回滾，之後可用 POST /api/contracts/[id]/files 補抓。
export async function saveContractFilesOnCompleted(contract: Contract): Promise<void> {
  try {
    await saveContractFiles(contract);
  } catch (e) {
    console.error(`[contract-files] 合約 ${contract.id} 完成時保存文件失敗：${errorMessage(e)}`);
  }
}

function isSaved(contractId: number, kind: ContractFileKind): boolean {
  return getContractFile(contractId, kind)?.status === 'saved';
}

async function saveMockSignedPdf(contract: Contract): Promise<SaveFileResult> {
  try {
    const pdf = await generateContractPdf(contract.fields);
    writeContractFile(contract.id, 'signed_pdf', Buffer.from(pdf), 'application/pdf');
    return { kind: 'signed_pdf', ok: true };
  } catch (e) {
    return recordFailure(contract.id, 'signed_pdf', errorMessage(e));
  }
}

function writeContractFile(contractId: number, kind: ContractFileKind, bytes: Buffer, contentType: string | null) {
  const relPath = contractFileRelPath(contractId, kind);
  const absPath = contractFileAbsPath(relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, bytes);
  upsertContractFile({
    contract_id: contractId,
    kind,
    status: 'saved',
    file_name: contractFileName(contractId, kind),
    rel_path: relPath,
    byte_size: bytes.length,
    content_type: contentType?.split(';')[0] || 'application/pdf',
    error: null,
  });
}

function recordFailure(contractId: number, kind: ContractFileKind, error: string): SaveFileResult {
  console.error(`[contract-files] 合約 ${contractId} 的 ${CONTRACT_FILE_LABELS[kind]} 保存失敗：${error}`);
  upsertContractFile({
    contract_id: contractId,
    kind,
    status: 'failed',
    file_name: contractFileName(contractId, kind),
    rel_path: null,
    byte_size: null,
    content_type: null,
    error,
  });
  return { kind, ok: false, error };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// 讀取已保存的檔案；檔案被刪掉時視為未保存，交給呼叫端補抓
export function readSavedContractFile(contractId: number, kind: ContractFileKind): { file: ContractFile; bytes: Buffer } | null {
  const file = getContractFile(contractId, kind);
  if (!file || file.status !== 'saved' || !file.rel_path) return null;
  const absPath = contractFileAbsPath(file.rel_path);
  if (!fs.existsSync(absPath)) return null;
  return { file, bytes: fs.readFileSync(absPath) };
}

// 下載端點共用：狀態不合回 4xx，沒保存到就當場補抓一次再回檔案
export async function serveContractFile(contract: Contract, kind: ContractFileKind): Promise<Response> {
  const label = CONTRACT_FILE_LABELS[kind];
  const check = checkContractFileDownloadable(contract, kind, { mock: isMockMode() });
  if (!check.ok) return Response.json({ error: check.error }, { status: check.status });

  let saved = readSavedContractFile(contract.id, kind);
  if (!saved) {
    const results = await saveContractFiles(contract, { only: [kind], force: true });
    saved = readSavedContractFile(contract.id, kind);
    if (!saved) {
      const failure = results.find((r) => r.kind === kind)?.error ?? '未知原因';
      return Response.json({ error: `取得${label}失敗：${failure}` }, { status: 502 });
    }
  }

  return new Response(new Uint8Array(saved.bytes), {
    headers: {
      'Content-Type': saved.file.content_type ?? 'application/pdf',
      'Content-Disposition': `attachment; filename="${saved.file.file_name}"`,
    },
  });
}

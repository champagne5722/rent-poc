import crypto from 'crypto';
import type { Contract, SignatureField } from './types';
import { PDF_PAGE_SIZE } from './pdf';

// 點點簽 sandbox 整合層。細節與待驗證事項見 docs/dottedsign-integration.md。
//
// 模式切換：設好 DOTTEDSIGN_CLIENT_ID / DOTTEDSIGN_CLIENT_SECRET 即為 live，
// 否則為 mock——送簽回假 task_id，狀態推進靠 /api/mock/advance 模擬 webhook。

const API_BASE = process.env.DOTTEDSIGN_API_BASE ?? 'https://api.sandbox.dottedsign.com';
const CLIENT_ID = process.env.DOTTEDSIGN_CLIENT_ID;
const CLIENT_SECRET = process.env.DOTTEDSIGN_CLIENT_SECRET;
const SCOPES = 'sign_tasks.general.write sign_tasks.general.read sign_tasks.management.write sign_tasks.download.read';

export function isMockMode(): boolean {
  return !CLIENT_ID || !CLIENT_SECRET;
}

interface TokenCache {
  accessToken: string;
  expiresAt: number; // epoch ms
}
const globalForToken = globalThis as unknown as { __dsToken?: TokenCache };

async function getAccessToken(): Promise<string> {
  const cached = globalForToken.__dsToken;
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;

  const res = await fetch(`${API_BASE}/v1/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: SCOPES,
    }),
  });
  if (!res.ok) throw new Error(`點點簽 token 取得失敗（${res.status}）：${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  globalForToken.__dsToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return json.access_token;
}

async function dsFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`點點簽 API ${path} 失敗（${res.status}）：${await res.text()}`);
  return res.json();
}

// 內部存的簽署區域是相對比例（原點左上、y 向下）；
// 點點簽 coord 為 [left-x, bottom-y, right-x, top-y]，原點左下。
// ⚠️ 文件未明說單位，此處假設為 PDF points——真接 sandbox 時需實測驗證（見整合筆記）。
export function toDsCoord(f: SignatureField): [number, number, number, number] {
  const { width: W, height: H } = PDF_PAGE_SIZE;
  const left = f.x * W;
  const right = (f.x + f.w) * W;
  const top = (1 - f.y) * H;
  const bottom = (1 - (f.y + f.h)) * H;
  return [round2(left), round2(bottom), round2(right), round2(top)];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function buildStage(name: string, email: string, fields: SignatureField[]) {
  return {
    name,
    email,
    stage_type: 'sign',
    field_settings: fields.map((f) => ({
      field_type: 'signature',
      page: f.page,
      coord: toDsCoord(f),
      options: { force: true },
    })),
    // decline_enable 不硬帶 true：signer 同時是 task owner（同帳號信箱）時 API 會回 400417，
    // 交由 API 預設（owner 預設 false、其他簽署人預設 true）
  };
}

export interface CreateTaskResult {
  taskId: string;
  mock: boolean;
}

// 送簽：乙方（租客）先簽、甲方（房東）後簽（has_order: true，stages 順序即簽署順序）
export async function createSignTask(contract: Contract, pdfBytes: Uint8Array): Promise<CreateTaskResult> {
  const { fields, signature_fields } = contract;
  const tenantFields = signature_fields.filter((f) => f.signer === 'tenant');
  const landlordFields = signature_fields.filter((f) => f.signer === 'landlord');

  if (isMockMode()) {
    return { taskId: `mock-${contract.id}-${crypto.randomUUID().slice(0, 8)}`, mock: true };
  }

  const body = {
    file_name: `租賃合約-${fields.propertyName || contract.id}`.replace(/[."*:<>?/\\|~#%&{}]/g, ''),
    base64_file: Buffer.from(pdfBytes).toString('base64'),
    has_order: true,
    start: true, // 預設 false 只會建立草稿、不寄信給簽署人（實測踩過）
    stages: [
      buildStage(fields.tenantName, fields.tenantEmail, tenantFields),
      buildStage(fields.landlordName, fields.landlordEmail, landlordFields),
    ],
  };
  const json = (await dsFetch('/v1/sign_tasks', { method: 'POST', body: JSON.stringify(body) })) as {
    data: { task_id: number };
  };
  return { taskId: String(json.data.task_id), mock: false };
}

export async function voidSignTask(taskId: string): Promise<void> {
  if (isMockMode()) return;
  await dsFetch('/v1/sign_tasks/void', {
    method: 'POST',
    body: JSON.stringify({ task_id: Number(taskId) }),
  });
}

export async function getSignedPdfDownloadLink(taskId: string): Promise<string | null> {
  if (isMockMode()) return null;
  const json = (await dsFetch(
    `/v1/sign_tasks/download_link?task_id=${encodeURIComponent(taskId)}&file_types[]=task`
  )) as { data?: { task?: string } };
  // 實測回應形狀：{ data: { task: "<S3 預簽連結>" } }，key 對應 file_types[] 的值
  return json.data?.task ?? null;
}

// webhook 簽章（已實測確認）：header `Signature` = HMAC-SHA256(client_secret, raw body) 的 hex
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (isMockMode()) return true;
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', CLIENT_SECRET!).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

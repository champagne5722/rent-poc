import crypto from 'crypto';
import { CONTRACT_FILE_LABELS } from '../types';
import type { ContractFileKind, SignatureField } from '../types';
import type {
  ParsedWebhook,
  SignableDocument,
  Signer,
  SigningEvent,
  SigningEventType,
  SigningProvider,
} from './provider';

// 點點簽 adapter：把簽署服務商的 API 細節集中在這裡。踩坑紀錄見 docs/dottedsign-integration.md。
// HTTP 與 token 在 ../dottedsign.ts，這裡只負責翻譯請求與 webhook。

export type DottedSignRequest = (path: string, init?: RequestInit) => Promise<unknown>;

// 下載預簽連結用。連結指向 S3，不帶點點簽的 token。
export type FetchFile = (url: string) => Promise<Response>;

export function createDottedSignProvider(deps: {
  request: DottedSignRequest;
  clientSecret: string;
  fetchFile?: FetchFile;
}): SigningProvider {
  const { request, clientSecret, fetchFile = (url) => fetch(url) } = deps;

  const postTaskId = (path: string, taskRef: string) =>
    request(path, { method: 'POST', body: JSON.stringify({ task_id: Number(taskRef) }) });

  return {
    id: 'dottedsign',
    mode: 'live',
    unsupported: { simulate: 'live 模式下請走真實 webhook' },

    async createTask({ document, signers }) {
      const json = (await request('/v1/sign_tasks', {
        method: 'POST',
        body: JSON.stringify(buildCreateTaskBody(document, signers)),
      })) as { data: { task_id: number } };
      return { taskRef: String(json.data.task_id) };
    },

    // 簽署連結只對當前簽署人有效，還沒輪到會回 400_937 stage_not_acting。
    async getSignLink(taskRef, email, redirectUrl) {
      // ⚠️ 文件寫 task_ids[]，sandbox 實測帶方括號（含未編碼）一律回 400998，只吃 task_ids=<id>（見整合筆記）
      let query = `task_ids=${encodeURIComponent(taskRef)}&email=${encodeURIComponent(email)}`;
      if (redirectUrl) query += `&redirect_url=${encodeURIComponent(redirectUrl)}`;
      const json = (await request(`/v1/sign_tasks/share_link?${query}`)) as { data?: { share_link?: string } };
      const link = json.data?.share_link;
      if (!link) throw new Error('點點簽未回傳簽署連結');
      return link;
    },

    // sandbox 不寄信，resend 一律回 403036（access_info.resend=false，見整合筆記），轉成看得懂的說明。
    async resend(taskRef) {
      try {
        await postTaskId('/v1/sign_tasks/resend', taskRef);
      } catch (e) {
        if (e instanceof Error && e.message.includes('task_not_accessible')) {
          throw new Error('點點簽拒絕重寄：sandbox 不提供 resend，正式環境才能驗證');
        }
        throw e;
      }
    },

    async voidTask(taskRef) {
      await postTaskId('/v1/sign_tasks/void', taskRef);
    },

    // 先取預簽連結再下載。scope 是 sign_tasks.download.read。
    // ⚠️ 參數名是 `file_types[]`，下載端點實測可用方括號，與 share_link 的 task_ids 不同（見整合筆記）。
    // 回應形狀：{ data: { task: "<S3 預簽連結>" } }，key 對應 file_types[] 的值。
    async downloadFile(taskRef, kind) {
      const fileType = DS_FILE_TYPES[kind];
      const json = (await request(
        `/v1/sign_tasks/download_link?task_id=${encodeURIComponent(taskRef)}&file_types[]=${fileType}`
      )) as { data?: Record<string, unknown> } | null;
      const link = json?.data?.[fileType];
      if (typeof link !== 'string' || !link) throw new Error(`點點簽未回傳${CONTRACT_FILE_LABELS[kind]}的下載連結`);
      // 預簽連結 15 分鐘失效且會 302 轉址，fetch 預設跟隨
      const res = await fetchFile(link);
      if (!res.ok) throw new Error(`下載連結回應 ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },

    parseWebhook(rawBody, headers) {
      // 後台儲存 webhook URL 時會送一記空 body 的驗證 ping（無簽章 header），需回 200 否則註冊失敗（實測踩過）
      if (!rawBody) return { kind: 'ping' };
      if (!verifySignature(rawBody, headers.get('signature'), clientSecret)) {
        return { kind: 'invalid', status: 401, reason: 'invalid signature' };
      }
      return parseDottedSignPayload(rawBody);
    },
  };
}

// 檔案種類對點點簽 file_types[] 的值。官方註明 audit_trail 需任務為 completed、declined 或 voided。
const DS_FILE_TYPES: Record<ContractFileKind, string> = {
  signed_pdf: 'task',
  audit_trail: 'audit_trail',
};

// 內部存的簽署區域是相對比例（原點左上、y 向下）；
// 點點簽 coord 為 [left-x, bottom-y, right-x, top-y]，原點左下，單位是 PDF points（已實測）。
export function toDsCoord(
  f: SignatureField,
  pageSize: SignableDocument['pageSize']
): [number, number, number, number] {
  const { width: W, height: H } = pageSize;
  const left = f.x * W;
  const right = (f.x + f.w) * W;
  const top = (1 - f.y) * H;
  const bottom = (1 - (f.y + f.h)) * H;
  return [round2(left), round2(bottom), round2(right), round2(top)];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function buildCreateTaskBody(document: SignableDocument, signers: Signer[]) {
  return {
    file_name: document.fileName.replace(/[."*:<>?/\\|~#%&{}]/g, ''),
    base64_file: Buffer.from(document.pdf).toString('base64'),
    has_order: true, // stages 順序即簽署順序
    start: true, // 預設 false 只會建立草稿、不寄信給簽署人（實測踩過）
    stages: signers.map((signer) => buildStage(signer, document.pageSize)),
  };
}

function buildStage(signer: Signer, pageSize: SignableDocument['pageSize']) {
  return {
    name: signer.name,
    email: signer.email,
    stage_type: 'sign',
    field_settings: signer.signatureFields.map((f) => ({
      field_type: 'signature',
      page: f.page,
      coord: toDsCoord(f, pageSize),
      options: { force: true },
    })),
    // decline_enable 不硬帶 true：signer 同時是 task owner（同帳號信箱）時 API 會回 400417，
    // 交由 API 預設（owner 預設 false、其他簽署人預設 true）
  };
}

// webhook 簽章（已實測確認）：header `Signature` = HMAC-SHA256(client_secret, raw body) 的 hex
function verifySignature(rawBody: string, signatureHeader: string | null, clientSecret: string): boolean {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', clientSecret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

const SIGNING_EVENT_TYPES: readonly SigningEventType[] = ['signed', 'completed', 'declined', 'voided'];

function isSigningEventType(action: unknown): action is SigningEventType {
  return SIGNING_EVENT_TYPES.includes(action as SigningEventType);
}

// payload 欄位：resource_id、resource_type、action_name、event_email（見整合筆記）。
// viewed 等未處理的事件一律忽略。拒簽原因：sandbox 實測的 payload 未帶，有 reason 欄位才放進事件。
export function parseDottedSignPayload(rawBody: string): ParsedWebhook {
  let payload: {
    resource_id?: unknown;
    resource_type?: unknown;
    action_name?: unknown;
    event_email?: unknown;
    reason?: unknown;
  } | null;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { kind: 'invalid', status: 400, reason: 'invalid json' };
  }

  if (payload?.resource_type !== 'task' || payload.resource_id == null || !isSigningEventType(payload.action_name)) {
    return { kind: 'ignored' };
  }

  const event: SigningEvent = { type: payload.action_name };
  if (typeof payload.event_email === 'string') event.email = payload.event_email;
  if (typeof payload.reason === 'string') event.reason = payload.reason;
  return { kind: 'event', taskRef: String(payload.resource_id), event };
}

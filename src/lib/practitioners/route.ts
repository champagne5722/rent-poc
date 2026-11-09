import type { ActionId } from '../access';
import { requestContext } from '../current-request-context';
import { jsonError } from '../http';
import { authorizeOnly } from '../org-route';
import type { SubmitActor } from '../practice-entities/flows';
import { EVIDENCE_MAX_BYTES, EVIDENCE_MAX_FILES, type EvidenceUpload } from '../practice-entities/rules';
import { Unauthenticated } from '../request-context';

// 執業人員 route 的共用骨架（MIL-111）。認證、組織型態與動作權限都在這裡，route 只剩解析請求與對應回應。

export const PRACTICE_ONLY_MESSAGE = '只有執業主體組織的成員能使用這個功能';

/**
 * 沒登入回 401，不是組織身分或不是執業主體組織回 403，動作權限不足回 authorize 的拒絕。
 * 先過權限再把檔案讀進記憶體。
 */
export async function requirePracticeActor(action: ActionId): Promise<{ ok: true; actor: SubmitActor } | { ok: false; response: Response }> {
  let rc;
  try {
    rc = await requestContext();
  } catch (error) {
    if (error instanceof Unauthenticated) return { ok: false, response: jsonError(401, error.message) };
    throw error;
  }
  if (rc.kind !== 'org') return { ok: false, response: jsonError(403, '此操作需要組織身分') };
  if (rc.orgKind !== 'practice') return { ok: false, response: jsonError(403, PRACTICE_ONLY_MESSAGE) };
  const denied = await authorizeOnly(action, { type: 'org' });
  if (denied) return { ok: false, response: denied };
  return { ok: true, actor: { orgId: rc.orgId, orgKind: rc.orgKind, role: rc.role, userId: rc.userId, partyId: rc.partyId } };
}

/** 讀 multipart 的檔案欄位。過大與過多的檔案在讀進記憶體之前擋下。 */
export async function readUploads(form: FormData, field = 'files'): Promise<{ ok: true; files: EvidenceUpload[] } | { ok: false; response: Response }> {
  const uploads = form.getAll(field).filter((v): v is File => typeof v !== 'string');
  if (uploads.length > EVIDENCE_MAX_FILES) {
    return { ok: false, response: jsonError(400, `一次最多上傳 ${EVIDENCE_MAX_FILES} 個檔案`, { extra: { field } }) };
  }
  if (uploads.some((f) => f.size > EVIDENCE_MAX_BYTES)) {
    return { ok: false, response: jsonError(400, `單一檔案不得超過 ${EVIDENCE_MAX_BYTES / 1024 / 1024} MB`, { extra: { field } }) };
  }
  const files = await Promise.all(uploads.map(async (f) => ({ fileName: f.name, contentType: f.type, bytes: new Uint8Array(await f.arrayBuffer()) })));
  return { ok: true, files };
}

/** 表單欄位轉成字串，其餘型別當成沒填。 */
export function formText(form: FormData, field: string): string | undefined {
  const value = form.get(field);
  return typeof value === 'string' ? value : undefined;
}

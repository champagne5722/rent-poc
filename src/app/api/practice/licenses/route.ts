import { requestContext } from '@/lib/current-request-context';
import { jsonError, jsonOk } from '@/lib/http';
import { authorizeOnly } from '@/lib/org-route';
import { EVIDENCE_MAX_BYTES, EVIDENCE_MAX_FILES, submitLicenseFlow } from '@/lib/practice-entities';
import { defaultFlowDeps } from '@/lib/practice-entities/deps';
import type { EvidenceUpload } from '@/lib/practice-entities/rules';
import { Unauthenticated } from '@/lib/request-context';

// 執業主體送出業別、證字號與證據檔（MIL-109）。multipart：kind、permitNo、files（多個）。
// 先寫 FileStore 再登記，登記失敗會刪檔（flows.ts）。審核台看到的是待核對項目，證據檔放 vault。

export async function POST(request: Request): Promise<Response> {
  let rc;
  try {
    rc = await requestContext();
  } catch (error) {
    if (error instanceof Unauthenticated) return jsonError(401, error.message);
    throw error;
  }
  if (rc.kind !== 'org') return jsonError(403, '此操作需要組織身分');
  // 先過權限（組織角色），再把檔案讀進記憶體。submitLicenseFlow 之後還會檢查組織型態必須是 practice
  const denied = await authorizeOnly('practice_registry.submit', { type: 'org' });
  if (denied) return denied;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(400, '請求本文必須是表單資料');
  }
  const uploads = form.getAll('files').filter((v): v is File => typeof v !== 'string');
  // 讀進記憶體之前先擋掉過大與過多的檔案
  if (uploads.length > EVIDENCE_MAX_FILES) return jsonError(400, `一次最多上傳 ${EVIDENCE_MAX_FILES} 個檔案`, { extra: { field: 'files' } });
  if (uploads.some((f) => f.size > EVIDENCE_MAX_BYTES)) {
    return jsonError(400, `單一檔案不得超過 ${EVIDENCE_MAX_BYTES / 1024 / 1024} MB`, { extra: { field: 'files' } });
  }
  const files: EvidenceUpload[] = await Promise.all(
    uploads.map(async (f) => ({ fileName: f.name, contentType: f.type, bytes: new Uint8Array(await f.arrayBuffer()) })),
  );

  const result = await submitLicenseFlow(
    { orgId: rc.orgId, orgKind: rc.orgKind, role: rc.role, userId: rc.userId, partyId: rc.partyId },
    { kind: form.get('kind'), permitNo: form.get('permitNo'), files },
    defaultFlowDeps(),
  );
  switch (result.status) {
    case 'submitted':
      return jsonOk({ data: { kind: result.kind } }, { status: 201 });
    case 'invalid':
      return jsonError(400, result.message, { extra: { field: result.field } });
    case 'company_required':
      return jsonError(400, result.message, { extra: { field: 'kind', code: 'company_required' } });
    case 'forbidden':
      return jsonError(403, '只有執業主體組織的管理員與業務人員能送件');
    case 'not_registered':
      return jsonError(409, '這個組織沒有執業主體登錄');
    case 'already_verified':
      return jsonError(409, '這個業別已驗證，不需要再送件');
    case 'conflict':
      return jsonError(409, '業別的狀態剛被改動，請重新整理後再送件');
  }
}

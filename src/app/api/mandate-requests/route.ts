import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { getFileStore } from '@/lib/file-store';
import { jsonError, jsonOk } from '@/lib/http';
import { deleteTranscriptFiles } from '@/lib/mandate-requests/files';
import { parseDraft } from '@/lib/mandate-requests/draft';
import { LICENSE_NOT_VERIFIED_MESSAGE, PRACTICE_ORG_REQUIRED_MESSAGE } from '@/lib/mandate-requests/messages';
import { listOwnerRequests } from '@/lib/mandate-requests/owner-repository';
import { createMandateRequest, expireMandateRequests, listPracticeRequests } from '@/lib/mandate-requests/repository';
import { inOrgTxAs, readJson } from '@/lib/org-route';
import { MANDATE_REQUEST_KINDS, type MandateRequestKind } from '@/lib/types';

// 申請（委託管理申請、住宅包租申請）的業者端入口（MIL-206，spec MIL-193）。
// 屋主端的路徑見 [id]、link/[code]。每個函式的政策（誰能呼叫、回什麼、為什麼）寫在 migration 0086 與 Linear MIL-206 的留言。

/**
 * 列出自己的申請，最新的 200 筆。業者回 PracticeMandateRequest[]，屋主回已綁定的 OwnerMandateRequest[]，形狀見 src/lib/types.ts。
 * 業者端的回應不含屋主的任何資料：屋主沒有送出之前，不論有沒有人打開、登入或綁定連結，業者讀到的內容逐位元相同。
 * 順手清掉已失效申請的代填資料與謄本檔。
 */
export async function GET() {
  const now = new Date();
  let expiredKeys: string[] = [];
  const response = await inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'request.read', { type: 'org' });
    if (rc.orgKind === 'owner') return jsonOk({ data: await listOwnerRequests(tx, now) });
    if (rc.orgKind !== 'practice') return jsonError(403, PRACTICE_ORG_REQUIRED_MESSAGE);
    expiredKeys = await expireMandateRequests(tx, now);
    return jsonOk({ data: await listPracticeRequests(tx, now) });
  });
  await deleteTranscriptFiles(getFileStore('general'), expiredKeys);
  return response;
}

/**
 * 業者產生申請連結。body：{ kind: 'management' | 'master_lease', draft?: 代填資料 }。
 * 只有對應業別已驗證的業者能產生（委託管理申請對代管業，住宅包租申請對包租業）。連結 7 天後失效，不論有沒有代填資料。
 * 201 回 PracticeMandateRequest 加 link_path（/request/<碼>）。碼只在這次回應出現，之後沒有地方能取回。
 * 代填資料只做格式驗證，不查建號有沒有被別人登錄，所以回應不因別人是否登錄過同一個建號而不同。
 * 這個 route 不寄任何 email。
 */
export async function POST(request: NextRequest) {
  const body = (await readJson(request)) as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError(400, '請求本文必須是 JSON 物件');
  const kind = body.kind;
  if (typeof kind !== 'string' || !(MANDATE_REQUEST_KINDS as readonly string[]).includes(kind)) {
    return jsonError(400, '申請的種類必須是 management（委託管理申請）或 master_lease（住宅包租申請）', { extra: { field: 'kind' } });
  }
  const draft = parseDraft(body.draft);
  if (!draft.ok) return jsonError(400, draft.error, { extra: { field: 'draft' } });

  const now = new Date();
  let expiredKeys: string[] = [];
  const response = await inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'request.create', { type: 'org' });
    if (rc.orgKind !== 'practice') return jsonError(403, PRACTICE_ORG_REQUIRED_MESSAGE);
    const created = await createMandateRequest(tx, { kind: kind as MandateRequestKind, draft: draft.draft, now });
    if (!created) return jsonError(403, LICENSE_NOT_VERIFIED_MESSAGE, 'license_not_verified');
    expiredKeys = await expireMandateRequests(tx, now);
    return jsonOk({ data: created }, { status: 201 });
  });
  await deleteTranscriptFiles(getFileStore('general'), expiredKeys);
  return response;
}

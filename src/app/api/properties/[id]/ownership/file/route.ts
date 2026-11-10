import { NextRequest } from 'next/server';
import { requestContext } from '@/lib/current-request-context';
import { getFileStore } from '@/lib/file-store';
import { jsonError } from '@/lib/http';
import { authorizeOnly } from '@/lib/org-route';
import { openOwnTranscriptFlow } from '@/lib/ownership';
import { isUlid } from '@/lib/pg/ulid';
import { propertyNotFound } from '@/lib/properties/not-found';
import { Unauthenticated } from '@/lib/request-context';

type Ctx = { params: Promise<{ id: string }> };

/**
 * 開啟物件目前的謄本原檔（MIL-201，ADR-0026 決議 8）。只有登錄的組織成員（admin、staff）；平台營運者走審核台的路徑。
 * 資料庫函式在同交易寫稽核事件（vault.read），事件寫入後才讀檔。每次開啟各寫一筆。
 * 檔案只能是 PDF、PNG、JPEG（送件時以內容驗證過），加 nosniff 與 no-store。
 */
export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return propertyNotFound();
  let rc;
  try {
    rc = await requestContext();
  } catch (error) {
    if (error instanceof Unauthenticated) return jsonError(401, error.message);
    throw error;
  }
  if (rc.kind !== 'org') return jsonError(403, '此操作需要組織身分');
  const denied = await authorizeOnly('property.manage', { type: 'property', id });
  if (denied) return denied;

  const result = await openOwnTranscriptFlow({ orgId: rc.orgId, partyId: rc.partyId }, id, { store: getFileStore('general') });
  switch (result.status) {
    case 'ok':
      return new Response(Buffer.from(result.bytes), {
        headers: {
          'content-type': result.contentType,
          'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        },
      });
    case 'not_found':
      return jsonError(404, '尚未上傳謄本');
    case 'file_missing':
      return jsonError(404, '謄本的檔案已遺失，請重新上傳');
    case 'file_corrupted':
      return jsonError(409, '謄本的內容與登記時不同，已拒絕開啟');
  }
}

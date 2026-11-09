import { NextRequest } from 'next/server';
import { getFileStore } from '@/lib/file-store';
import { jsonError } from '@/lib/http';
import { loadSignedPdf } from '@/lib/tenant';
import { caseIdOf, caseNotFound, inTenantContext, type CaseRouteCtx } from '@/lib/tenant/route';

// 下載已簽 PDF（MIL-121）。成員資格與案件狀態由 withCaseMemberTx 檢查，結案後仍可下載（P0-09 AC6）。
// 檔案經 FileStore 讀取。這裡不向簽署服務商補抓：補抓需要組織脈絡，由出租人端的下載入口負責。
export async function GET(_request: NextRequest, { params }: CaseRouteCtx) {
  const caseId = await caseIdOf(params);
  if (!caseId) return caseNotFound();
  return inTenantContext(async (rc) => {
    const result = await loadSignedPdf(rc, caseId, getFileStore('signed-document'));
    if (!result.ok) {
      return result.reason === 'not_completed'
        ? jsonError(409, '合約尚未完成簽署，已簽合約尚未產生')
        : jsonError(404, '已簽合約暫時無法下載，請聯絡出租人');
    }
    return new Response(new Uint8Array(result.bytes), {
      headers: {
        'Content-Type': result.contentType,
        'Content-Disposition': contentDisposition(result.fileName),
        // 個人的法律文件，不讓共用快取留存
        'Cache-Control': 'private, no-store',
      },
    });
  });
}

/** 檔名可能含中文：ASCII 備援加 RFC 5987 的 UTF-8 檔名，瀏覽器優先用後者。 */
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

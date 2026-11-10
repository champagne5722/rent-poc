import { getFileStore } from '@/lib/file-store';
import { jsonError } from '@/lib/http';
import { openOwnershipReviewFile } from '@/lib/ownership';
import { requireOwnershipOperator } from '@/lib/ownership/operator';
import { isUlid } from '@/lib/pg/ulid';

type Ctx = { params: Promise<{ id: string }> };

/**
 * 營運者開啟審核項目的謄本原檔（MIL-201，ADR-0026 決議 8）。只有平台營運者。
 * 資料庫函式在登錄方組織的鏈寫稽核事件（vault.read，行為者是營運者），事件寫入後才讀檔。每次開啟各寫一筆。
 * 檔案只能是 PDF、PNG、JPEG（送件時以內容驗證過），加 nosniff 與 no-store。
 */
export async function GET(_request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  if (!isUlid(id)) return jsonError(404, '審核項目不存在');
  const operator = await requireOwnershipOperator();
  if (!operator.ok) return operator.response;
  const result = await openOwnershipReviewFile(operator.runs, id, getFileStore('general'));
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
      return jsonError(404, '謄本不存在');
    case 'file_missing':
      return jsonError(404, '謄本的檔案已遺失，請通知使用者重新上傳');
    case 'file_corrupted':
      return jsonError(409, '謄本的內容與登記時不同，已拒絕開啟');
  }
}

import { getFileStore } from '@/lib/file-store';
import { jsonError } from '@/lib/http';
import { openConflictPeerFile } from '@/lib/ownership/conflict';
import { requireOwnershipOperator } from '@/lib/ownership/operator';
import { isUlid } from '@/lib/pg/ulid';

type Ctx = { params: Promise<{ id: string }> };

/**
 * 營運者開啟先前的一方的謄本原檔（MIL-208）。只有平台營運者。[id] 是後來的一方的審核項目編號。
 * 後來的一方的原檔用 GET /api/desk/ownership/[id]/file。資料庫函式在先前的一方的鏈寫稽核事件
 * （vault.read，行為者是營運者，工單號只含它自己的節點 ID），事件寫入後才讀檔。每次開啟各寫一筆。
 */
export async function GET(_request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  if (!isUlid(id)) return jsonError(404, '衝突個案不存在');
  const operator = await requireOwnershipOperator();
  if (!operator.ok) return operator.response;
  const result = await openConflictPeerFile(operator.runs, id, getFileStore('general'));
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
      return jsonError(404, '謄本的檔案已遺失');
    case 'file_corrupted':
      return jsonError(409, '謄本的內容與登記時不同，已拒絕開啟');
  }
}

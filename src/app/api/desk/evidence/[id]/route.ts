import { jsonError } from '@/lib/http';
import { isUlid } from '@/lib/pg/ulid';
import { openEvidenceFlow } from '@/lib/practice-entities';
import { defaultFlowDeps } from '@/lib/practice-entities/deps';
import { requireOperator } from '@/lib/practice-entities/operator-tx';

type Ctx = { params: Promise<{ id: string }> };

// 開啟證據檔（MIL-109，ADR-0017 補充）。只有平台營運者。先在交易內寫 vault.read 稽核事件，再讀檔案。
// 已刪除的證據檔回 404。檔案只能是 PDF、PNG、JPEG（送件時以內容驗證過），加 nosniff 與 no-store。

export async function GET(_request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  if (!isUlid(id)) return jsonError(404, '證據檔不存在');
  const operator = await requireOperator();
  if (!operator.ok) return operator.response;

  const result = await openEvidenceFlow(operator.run, id, defaultFlowDeps());
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
      return jsonError(404, '證據檔不存在');
    case 'file_missing':
      return jsonError(404, '證據檔的檔案已遺失，請通知執業主體重新上傳');
    case 'file_corrupted':
      return jsonError(409, '證據檔的內容與登記時不同，已拒絕開啟');
  }
}

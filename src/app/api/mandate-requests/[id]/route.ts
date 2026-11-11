import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { jsonError, jsonOk } from '@/lib/http';
import { NOT_OWNER_ORG_MESSAGE, REQUEST_NOT_FOUND_MESSAGE } from '@/lib/mandate-requests/messages';
import { getOwnerRequest } from '@/lib/mandate-requests/owner-repository';
import { getPracticeRequest } from '@/lib/mandate-requests/repository';
import { inOrgTxAs } from '@/lib/org-route';
import { isUlid } from '@/lib/pg/ulid';

type Ctx = { params: Promise<{ id: string }> };

/**
 * 讀一份申請。依呼叫者的組織種類回不同形狀：
 * - 業者：PracticeMandateRequest。沒有屋主的任何資料，屋主沒送出之前，不論有沒有人打開、登入或綁定連結，內容逐位元相同。
 * - 屋主：OwnerMandateRequest。只有已經綁定的屋主組織讀得到，含業者名稱、統編、代填資料與個資告知文字。
 * 別的組織的申請、沒綁定的連結、不存在的申請、格式錯誤的 ID，回應逐位元相同：404 與固定訊息。
 */
export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return jsonError(404, REQUEST_NOT_FOUND_MESSAGE);
  const now = new Date();
  return inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'request.read', { type: 'org' });
    if (rc.orgKind === 'practice') {
      const view = await getPracticeRequest(tx, id, now);
      return view ? jsonOk({ data: view }) : jsonError(404, REQUEST_NOT_FOUND_MESSAGE);
    }
    if (rc.orgKind === 'owner') {
      const view = await getOwnerRequest(tx, id, now);
      return view ? jsonOk({ data: view }) : jsonError(404, REQUEST_NOT_FOUND_MESSAGE);
    }
    return jsonError(403, NOT_OWNER_ORG_MESSAGE);
  });
}

import { NextRequest } from 'next/server';
import { requestContext } from '@/lib/current-request-context';
import { jsonError, jsonOk } from '@/lib/http';
import { isWellFormedRequestCode } from '@/lib/mandate-requests/code';
import { LINK_INVALID_MESSAGE } from '@/lib/mandate-requests/messages';
import { getLinkView } from '@/lib/mandate-requests/repository';
import { withTx } from '@/lib/pg/database';
import { toDbContext, Unauthenticated } from '@/lib/request-context';

type Ctx = { params: Promise<{ code: string }> };

// 登入前的連結頁資料（MIL-206 驗收 6、13、17）。不需要登入。
// 有效的連結回 200：業者名稱、統編、已驗證的業別、申請種類、連結失效時間，沒有別的。
// 其餘一律回同一個 404 與同一句固定訊息，標頭也相同：格式錯誤、查無此碼、已過期、已送出、已收回、
// 已被別的屋主組織綁定、業者的業別已不是已驗證。回應逐位元相同，呼叫者分不出是哪一種。
// 不得回傳：代填的地址、建號、謄本、屋主組織、綁定與否、任何物件資料。

const NO_STORE = { 'Cache-Control': 'no-store' };

const invalid = () => jsonError(404, LINK_INVALID_MESSAGE, { headers: NO_STORE });

export async function GET(_request: NextRequest, { params }: Ctx) {
  const { code } = await params;
  if (!isWellFormedRequestCode(code)) return invalid();
  const now = new Date();

  // 登入後打開連結的屋主，資料庫函式要知道他的組織，才能把「已被別的組織綁定」當成無效。沒登入走 control 脈絡
  let ctx: Parameters<typeof withTx>[0] = { kind: 'control' };
  try {
    const rc = await requestContext();
    if (rc.kind === 'org') ctx = toDbContext(rc);
  } catch (error) {
    if (!(error instanceof Unauthenticated)) throw error;
  }

  const view = await withTx(ctx, (tx) => getLinkView(tx, code, now));
  return view ? jsonOk({ data: view }, { headers: NO_STORE }) : invalid();
}

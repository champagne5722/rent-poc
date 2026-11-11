import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { jsonOk, jsonError } from '@/lib/http';
import { inOrgTx, readJson } from '@/lib/org-route';
import { listProperties, listPropertyGroups, parsePropertyCreateInput, registerProperty } from '@/lib/properties';

// 預設回扁平列表：一列一個租賃單位。?group=object 回依物件分組的列表：一筆一個物件，底下帶出租賃單位與核對狀態（MIL-202）。
export async function GET(request?: NextRequest) {
  const grouped = request?.nextUrl.searchParams.get('group') === 'object';
  return inOrgTx(async (tx) => {
    await authorize(tx, 'property.read', { type: 'org' });
    return jsonOk({ data: grouped ? await listPropertyGroups(tx) : await listProperties(tx) });
  });
}

// 登錄物件（ADR-0028 決議 1、2、6）。建號必填。
// 鍵有沒有撞到別的組織、有沒有超過次數，回應都一樣：201 與物件 ID，加上對外狀態。
// 唯一的例外是鍵已被自己的組織登錄：回 200 與自己既有的那一筆。
export async function POST(request: NextRequest) {
  const parsed = parsePropertyCreateInput(await readJson(request));
  if (!parsed.ok) return jsonError(400, parsed.error);
  // 建物件時同一個交易建待驗證錨點與 0000 單位，表單就地新增的自訂設備也一併補進詞彙庫
  return inOrgTx(async (tx) => {
    await authorize(tx, 'property.manage', { type: 'org' });
    const result = await registerProperty(tx, parsed.value);
    switch (result.kind) {
      case 'created':
        return jsonOk({ data: { id: result.id, verification_status: 'pending_verification' } }, { status: 201 });
      case 'existing':
        // 鍵已被自己的組織登錄：沒有建新物件，回自己既有的那筆
        return jsonOk({ data: { id: result.id, existing: true } });
    }
  });
}

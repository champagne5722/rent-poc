import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { jsonOk, jsonError } from '@/lib/http';
import { inOrgTx, readJson } from '@/lib/org-route';
import { addCustomItem, listVocabulary } from '@/lib/properties';

// 設備詞彙庫（ADR-0008）：組織層級的設備項目字典，物件表單從這裡挑項目。
// 每個組織各有一份：平台預設加組織自訂。只提供列出與新增自訂項目，
// 刪除留待有使用中檢查再開。

export async function GET() {
  return inOrgTx(async (tx) => {
    await authorize(tx, 'property.read', { type: 'org' });
    return jsonOk({ data: await listVocabulary(tx) });
  });
}

export async function POST(request: NextRequest) {
  const body = await readJson(request);
  const name =
    typeof body === 'object' && body !== null && typeof (body as { name?: unknown }).name === 'string'
      ? (body as { name: string }).name.trim()
      : '';
  if (!name) return jsonError(400, '請輸入設備名稱');

  return inOrgTx(async (tx) => {
    await authorize(tx, 'property.manage', { type: 'org' });
    const added = await addCustomItem(tx, name);
    if (!added) return jsonError(409, `「${name}」已在設備詞彙庫中`);
    return jsonOk({ data: added }, { status: 201 });
  });
}

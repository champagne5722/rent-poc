import { NextRequest } from 'next/server';
import { addCustomEquipmentItem, listEquipmentVocabulary } from '@/lib/db';
import { jsonOk, jsonError } from '@/lib/http';

// 設備詞彙庫（ADR-0008）：房東層的設備項目字典，物件表單從這裡挑項目。
// PoC 沒有登入，實質全系統一份；只提供列出與新增自訂項目，刪除留待有使用中檢查再開。

export async function GET() {
  return jsonOk({ data: listEquipmentVocabulary() });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return jsonError(400, '請輸入設備名稱');

  const added = addCustomEquipmentItem(name);
  if (!added) return jsonError(409, `「${name}」已在設備詞彙庫中`);
  return jsonOk({ data: added }, { status: 201 });
}

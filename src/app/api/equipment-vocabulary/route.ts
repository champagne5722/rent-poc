import { NextRequest } from 'next/server';
import { addCustomEquipmentItem, listEquipmentVocabulary } from '@/lib/db';

// 設備詞彙庫（ADR-0008）：房東層的設備項目字典，物件表單從這裡挑項目。
// PoC 沒有登入，實質全系統一份；只提供列出與新增自訂項目，刪除留待有使用中檢查再開。

export async function GET() {
  return Response.json({ data: listEquipmentVocabulary() });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return Response.json({ error: '請輸入設備名稱' }, { status: 400 });

  const added = addCustomEquipmentItem(name);
  if (!added) return Response.json({ error: `「${name}」已在設備詞彙庫中` }, { status: 409 });
  return Response.json({ data: added }, { status: 201 });
}

import { NextRequest } from 'next/server';
import { ensureEquipmentVocabulary, getDb, listProperties } from '@/lib/db';
import { parseEquipmentPayload } from '@/lib/equipment';

export async function GET() {
  return Response.json({ data: listProperties() });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, address, type, size, default_rent, note, equipment } = body;
  if (!name?.trim() || !address?.trim()) {
    return Response.json({ error: '名稱與地址為必填' }, { status: 400 });
  }
  const items = parseEquipmentPayload(equipment);
  if (!items) {
    return Response.json({ error: '設備清單格式有誤：每項需有名稱且數量為正整數，且不可重複' }, { status: 400 });
  }
  // 表單可以就地新增自訂項目，這裡再補一次確保詞彙庫跟得上實際存下的清單
  ensureEquipmentVocabulary(items.map((i) => i.name));
  const result = getDb()
    .prepare(
      'INSERT INTO properties (name, address, type, size, default_rent, note, equipment) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      name.trim(),
      address.trim(),
      type ?? '整層住家',
      size ?? null,
      default_rent ?? null,
      note ?? '',
      JSON.stringify(items)
    );
  return Response.json({ data: { id: Number(result.lastInsertRowid) } }, { status: 201 });
}

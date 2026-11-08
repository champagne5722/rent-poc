import { NextRequest } from 'next/server';
import { ensureEquipmentVocabulary, getDb, getProperty } from '@/lib/db';
import { parseEquipmentPayload } from '@/lib/equipment';
import { jsonOk, jsonError } from '@/lib/http';

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const property = getProperty(Number(id));
  if (!property) return jsonError(404, '物件不存在');

  const body = await request.json();
  const { name, address, type, size, default_rent, note, equipment } = body;
  if (!name?.trim() || !address?.trim()) {
    return jsonError(400, '名稱與地址為必填');
  }
  const items = parseEquipmentPayload(equipment);
  if (!items) {
    return jsonError(400, '設備清單格式有誤：每項需有名稱且數量為正整數，且不可重複');
  }
  // 表單可以就地新增自訂項目，這裡再補一次確保詞彙庫跟得上實際存下的清單
  ensureEquipmentVocabulary(items.map((i) => i.name));
  getDb()
    .prepare(
      "UPDATE properties SET name=?, address=?, type=?, size=?, default_rent=?, note=?, equipment=?, updated_at=datetime('now','localtime') WHERE id=?"
    )
    .run(
      name.trim(),
      address.trim(),
      type ?? property.type,
      size ?? null,
      default_rent ?? null,
      note ?? '',
      JSON.stringify(items),
      property.id
    );
  return jsonOk({ data: { id: property.id } });
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  getDb().prepare('DELETE FROM properties WHERE id=?').run(Number(id));
  return jsonOk({ data: { id: Number(id) } });
}

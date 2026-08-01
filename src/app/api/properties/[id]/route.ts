import { NextRequest } from 'next/server';
import { getDb, getProperty } from '@/lib/db';

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const property = getProperty(Number(id));
  if (!property) return Response.json({ error: '物件不存在' }, { status: 404 });

  const body = await request.json();
  const { name, address, type, size, default_rent, note, equipment } = body;
  if (!name?.trim() || !address?.trim()) {
    return Response.json({ error: '名稱與地址為必填' }, { status: 400 });
  }
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
      JSON.stringify(equipment ?? []),
      property.id
    );
  return Response.json({ data: { id: property.id } });
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  getDb().prepare('DELETE FROM properties WHERE id=?').run(Number(id));
  return Response.json({ data: { id: Number(id) } });
}

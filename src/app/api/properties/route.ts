import { NextRequest } from 'next/server';
import { getDb, listProperties } from '@/lib/db';

export async function GET() {
  return Response.json({ data: listProperties() });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, address, type, size, default_rent, note, equipment } = body;
  if (!name?.trim() || !address?.trim()) {
    return Response.json({ error: '名稱與地址為必填' }, { status: 400 });
  }
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
      JSON.stringify(equipment ?? [])
    );
  return Response.json({ data: { id: Number(result.lastInsertRowid) } }, { status: 201 });
}

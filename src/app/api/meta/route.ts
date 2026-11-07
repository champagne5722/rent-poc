import { signing } from '@/lib/signing-module';

export async function GET() {
  return Response.json({ data: { mock: (await signing.mode()) === 'mock' } });
}

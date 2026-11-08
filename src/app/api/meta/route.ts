import { signing } from '@/lib/signing-module';
import { jsonOk } from '@/lib/http';

export async function GET() {
  return jsonOk({ data: { mock: (await signing.mode()) === 'mock' } });
}

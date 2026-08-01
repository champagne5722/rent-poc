import { isMockMode } from '@/lib/dottedsign';

export async function GET() {
  return Response.json({ data: { mock: isMockMode() } });
}

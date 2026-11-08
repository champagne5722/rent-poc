import { whoAmI } from '@/lib/auth/whoami';
import { requestContext } from '@/lib/current-request-context';
import { jsonError, jsonOk } from '@/lib/http';
import { Unauthenticated } from '@/lib/request-context';

// 殼層顯示用：目前登入者的名稱與身分（MIL-103）。

export async function GET(): Promise<Response> {
  try {
    return jsonOk({ data: await whoAmI(await requestContext()) });
  } catch (error) {
    if (error instanceof Unauthenticated) return jsonError(401, error.message);
    throw error;
  }
}

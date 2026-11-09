import { jsonError, jsonOk } from '@/lib/http';
import type { OnboardingResult } from '@/lib/orgs/onboarding';

// 兩個建組織 route 共用的回應對照。檔名不是 route.ts，Next 不會把它當成 route。

export function onboardingResponse(result: OnboardingResult): Response {
  switch (result.status) {
    case 'ok':
      return jsonOk({ data: { redirectTo: result.landing } });
    case 'unauthenticated':
      return jsonError(401, '尚未登入或沒有存取權');
    case 'has_identity':
      return jsonError(409, '這個帳號已經有身分，不能再建立第一個組織');
    case 'invalid':
      return jsonError(400, result.message, { extra: { field: result.field, ...(result.code ? { code: result.code } : {}) } });
  }
}

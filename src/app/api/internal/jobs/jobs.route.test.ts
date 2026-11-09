import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { proxy } from '@/proxy';
import { POST } from './[name]/route';

// route 層的接線：環境變數、Basic Auth 放行與呼叫者驗證（ADR-0020 決議 2）。
// 驗證細節在 src/lib/jobs/handler.test.ts，這裡只確認真實的 route 接得起來，而且沒有帶 OIDC token 就不執行。

const url = 'https://rent-poc-demo.example.run.app/api/internal/jobs/drain-inbox';
const call = (headers: Record<string, string> = {}, name = 'drain-inbox') =>
  POST(new NextRequest(url, { method: 'POST', headers }), { params: Promise.resolve({ name }) });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/internal/jobs/:name', () => {
  it('沒有設定 JOBS_OIDC_AUDIENCE 與 JOBS_OIDC_SERVICE_ACCOUNT：503，不執行', async () => {
    vi.stubEnv('JOBS_OIDC_AUDIENCE', '');
    vi.stubEnv('JOBS_OIDC_SERVICE_ACCOUNT', '');
    expect((await call({ authorization: 'Bearer a.b.c' })).status).toBe(503);
  });

  it('設定好之後，沒有 token 或 token 無效：401', async () => {
    vi.stubEnv('JOBS_OIDC_AUDIENCE', 'https://rent-poc-demo.example.run.app');
    vi.stubEnv('JOBS_OIDC_SERVICE_ACCOUNT', 'scheduler@rent-poc.iam.gserviceaccount.com');
    expect((await call()).status).toBe(401);
    expect((await call({ authorization: 'Bearer not-a-jwt' })).status).toBe(401);
    expect((await call({ authorization: 'Basic ZGVtbzpwYXNz' })).status).toBe(401);
  });
});

describe('Basic Auth 與內部 job 路徑', () => {
  const request = (path: string, authorization?: string) =>
    new NextRequest(`https://rent-poc-demo.example.run.app${path}`, {
      method: 'POST',
      headers: authorization ? { authorization } : {},
    });

  it('demo 設了 Basic Auth 密碼時，job 路徑仍放行（交給 OIDC 驗證），其他內部路徑被擋', () => {
    vi.stubEnv('DEMO_BASIC_AUTH_USER', 'demo');
    vi.stubEnv('DEMO_BASIC_AUTH_PASSWORD', 'secret');
    vi.stubEnv('K_SERVICE', 'rent-poc-demo');

    expect(proxy(request('/api/internal/jobs/drain-inbox', 'Bearer token')).status).toBe(200);
    expect(proxy(request('/api/internal/other', 'Bearer token')).status).toBe(401);
    expect(proxy(request('/api/internal/jobs/drain-inbox/extra', 'Bearer token')).status).toBe(401);
  });
});

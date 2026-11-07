import { describe, expect, it } from 'vitest';
import type { SignatureField } from '../types';
import { createDottedSignProvider, toDsCoord, type DottedSignRequest } from './dottedsign-adapter';
import type { SignableDocument, Signer } from './provider';

const A4 = { width: 595.28, height: 841.89 };

// 期望值以 A4（595.28 × 841.89 points）手算：
// 相對比例（原點左上、y 向下）→ 點點簽 [left-x, bottom-y, right-x, top-y]（原點左下）
describe('toDsCoord（簽署區域座標轉換）', () => {
  const field = (f: Partial<SignatureField>): SignatureField => ({
    id: 'f1',
    signer: 'party_b',
    page: 0,
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    ...f,
  });

  it('整頁區域對應整頁 points', () => {
    expect(toDsCoord(field({}), A4)).toEqual([0, 0, 595.28, 841.89]);
  });

  it('左上四分之一頁：y 軸翻轉為左下原點', () => {
    // left = 0.25×595.28 = 148.82, right = 0.75×595.28 = 446.46
    // top = (1−0.25)×841.89 = 631.42, bottom = (1−0.75)×841.89 = 210.47（四捨五入到小數 2 位）
    expect(toDsCoord(field({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }), A4)).toEqual([148.82, 210.47, 446.46, 631.42]);
  });

  it('頁面尺寸由文件決定', () => {
    expect(toDsCoord(field({}), { width: 100, height: 200 })).toEqual([0, 0, 100, 200]);
  });
});

// 擷取 adapter 送出的請求，不打網路
function capture(response: unknown = { data: { task_id: 470 } }) {
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  const request: DottedSignRequest = async (path, init) => {
    calls.push({
      path,
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return response;
  };
  return { calls, provider: createDottedSignProvider({ request, clientSecret: 'test-secret' }) };
}

const failing = (message: string) =>
  createDottedSignProvider({
    request: async () => {
      throw new Error(message);
    },
    clientSecret: 'test-secret',
  });

describe('建立任務的請求組裝', () => {
  const document: SignableDocument = {
    fileName: '租賃合約-A.棟#3/2F',
    pdf: new Uint8Array([37, 80, 68, 70]),
    pageSize: A4,
  };
  const signers: Signer[] = [
    {
      role: 'party_b',
      name: '王租客',
      email: 'tenant@example.com',
      signatureFields: [{ id: 'f1', signer: 'party_b', page: 2, x: 0.1, y: 0.8, w: 0.2, h: 0.1 }],
    },
    {
      role: 'party_a',
      name: '林房東',
      email: 'landlord@example.com',
      signatureFields: [{ id: 'f2', signer: 'party_a', page: 2, x: 0, y: 0, w: 1, h: 1 }],
    },
  ];

  it('一位簽署人帶多個角色的簽署區域時，組成同一個 stage 的多個 field_settings', async () => {
    const { calls, provider } = capture();
    await provider.createTask({
      subject: { type: 'contract', id: 7 },
      document,
      signers: [
        {
          role: 'practitioner',
          name: '陳管理',
          email: 'manager@example.com',
          signatureFields: [
            { id: 'f1', signer: 'practitioner', page: 0, x: 0, y: 0, w: 1, h: 1 },
            { id: 'f2', signer: 'party_a', page: 1, x: 0, y: 0, w: 1, h: 1 },
          ],
        },
      ],
    });

    const body = calls[0].body as { stages: { field_settings: { page: number }[] }[] };
    expect(body.stages).toHaveLength(1);
    expect(body.stages[0].field_settings.map((f) => f.page)).toEqual([0, 1]);
  });

  it('依序簽署、立即開始，stages 順序等於簽署序列，檔名清洗掉特殊字元', async () => {
    const { calls, provider } = capture();
    const { taskRef } = await provider.createTask({ subject: { type: 'contract', id: 7 }, document, signers });

    expect(taskRef).toBe('470');
    expect(calls).toEqual([
      {
        path: '/v1/sign_tasks',
        method: 'POST',
        body: {
          file_name: '租賃合約-A棟32F',
          base64_file: 'JVBERg==',
          has_order: true,
          start: true,
          stages: [
            {
              name: '王租客',
              email: 'tenant@example.com',
              stage_type: 'sign',
              field_settings: [
                {
                  field_type: 'signature',
                  page: 2,
                  coord: [59.53, 84.19, 178.58, 168.38],
                  options: { force: true },
                },
              ],
            },
            {
              name: '林房東',
              email: 'landlord@example.com',
              stage_type: 'sign',
              field_settings: [
                { field_type: 'signature', page: 2, coord: [0, 0, 595.28, 841.89], options: { force: true } },
              ],
            },
          ],
        },
      },
    ]);
  });
});

describe('webhook 簽章', () => {
  const rawBody = '{"resource_id":470,"resource_type":"task","action_name":"signed","event_email":"Tenant@example.com"}';
  // 以 openssl 預先算好：printf '%s' <rawBody> | openssl dgst -sha256 -hmac test-secret
  const signature = '45f0e7ec8d02c864fba5e448d0c31302a15d8602db79001c25f520387283c8cb';
  const { provider } = capture();

  it('正確的 HMAC-SHA256 hex 簽章會解析出事件，email 保持原樣', () => {
    expect(provider.parseWebhook(rawBody, new Headers({ signature }))).toEqual({
      kind: 'event',
      taskRef: '470',
      event: { type: 'signed', email: 'Tenant@example.com' },
    });
  });

  it('沒有簽章 header 時回無效，狀態碼 401', () => {
    expect(provider.parseWebhook(rawBody, new Headers())).toEqual({
      kind: 'invalid',
      status: 401,
      reason: 'invalid signature',
    });
  });

  it('簽章不符時回無效，狀態碼 401', () => {
    const wrong = signature.replace(/^4/, '5');
    expect(provider.parseWebhook(rawBody, new Headers({ signature: wrong }))).toMatchObject({
      kind: 'invalid',
      status: 401,
    });
  });

  it('簽章長度不符時回無效，不拋例外', () => {
    expect(provider.parseWebhook(rawBody, new Headers({ signature: 'short' }))).toMatchObject({
      kind: 'invalid',
      status: 401,
    });
  });

  it('body 不是 JSON 且簽章錯誤時，先回簽章錯誤', () => {
    expect(provider.parseWebhook('not-json', new Headers({ signature }))).toMatchObject({
      kind: 'invalid',
      status: 401,
    });
  });
});

describe('簽署連結、重寄與撤回', () => {
  it('簽署連結的 query 用 task_ids，帶編碼後的 email 與導回網址', async () => {
    const { calls, provider } = capture({ data: { share_link: 'https://sandbox.dottedsign.com/task?code=abc' } });
    await expect(provider.getSignLink('470', 'a+b@example.com', 'https://app.example/contracts/7')).resolves.toBe(
      'https://sandbox.dottedsign.com/task?code=abc'
    );
    expect(calls[0].path).toBe(
      '/v1/sign_tasks/share_link?task_ids=470&email=a%2Bb%40example.com&redirect_url=https%3A%2F%2Fapp.example%2Fcontracts%2F7'
    );
  });

  it('點點簽沒回連結時回報錯誤', async () => {
    const { provider } = capture({ data: {} });
    await expect(provider.getSignLink('470', 'a@example.com')).rejects.toThrow('點點簽未回傳簽署連結');
  });

  it.each([
    ['重寄', '/v1/sign_tasks/resend', 'resend'],
    ['撤回', '/v1/sign_tasks/void', 'voidTask'],
  ] as const)('%s 以 POST 送整數 task_id', async (_label, path, method) => {
    const { calls, provider } = capture();
    await provider[method]('470');
    expect(calls).toEqual([{ path, method: 'POST', body: { task_id: 470 } }]);
  });

  it('sandbox 的 resend 回 task_not_accessible 時，轉成看得懂的說明', async () => {
    const provider = failing('點點簽 API /v1/sign_tasks/resend 失敗（403）：{"error_key":"task_not_accessible"}');
    await expect(provider.resend('470')).rejects.toThrow('點點簽拒絕重寄：sandbox 不提供 resend，正式環境才能驗證');
  });

  it('resend 的其他錯誤原樣往外拋', async () => {
    await expect(failing('點點簽 API 失敗（500）').resend('470')).rejects.toThrow('點點簽 API 失敗（500）');
  });
});

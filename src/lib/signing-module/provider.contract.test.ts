import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { createDottedSignProvider } from './dottedsign-adapter';
import { createMockProvider } from './mock-adapter';
import type { SignableDocument, Signer, SigningProvider } from './provider';

// 兩個 adapter 共用這組契約測試：Mock 的行為必須可信，所以它與點點簽 adapter 走同一份斷言。
// 每個 adapter 提供 provider，並提供「把 raw body 包成該服務商會接受的 headers」。
interface ContractSetup {
  provider: SigningProvider;
  headersFor(rawBody: string): Headers;
}

const document: SignableDocument = {
  fileName: '租賃合約-測試物件',
  pdf: new Uint8Array([37, 80, 68, 70]),
  pageSize: { width: 595.28, height: 841.89 },
};

const signers: Signer[] = [
  {
    role: 'tenant',
    name: '王租客',
    email: 'tenant@example.com',
    signatureFields: [{ id: 'f1', signer: 'tenant', page: 0, x: 0.1, y: 0.8, w: 0.2, h: 0.1 }],
  },
  {
    role: 'landlord',
    name: '林房東',
    email: 'landlord@example.com',
    signatureFields: [{ id: 'f2', signer: 'landlord', page: 0, x: 0.6, y: 0.8, w: 0.2, h: 0.1 }],
  },
];

const subject = { type: 'contract', id: 7 } as const;

const taskPayload = (action: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ resource_id: 470, resource_type: 'task', action_name: action, ...extra });

function describeProviderContract(name: string, setup: () => ContractSetup) {
  describe(`SigningProvider 契約：${name}`, () => {
    const parse = (rawBody: string) => {
      const { provider, headersFor } = setup();
      return provider.parseWebhook(rawBody, headersFor(rawBody));
    };

    it('建立任務回傳非空的服務商任務編號，每次都不同', async () => {
      const { provider } = setup();
      const first = await provider.createTask({ subject, document, signers });
      const second = await provider.createTask({ subject, document, signers });
      expect(first.taskRef).toEqual(expect.any(String));
      expect(first.taskRef).not.toBe('');
      expect(second.taskRef).not.toBe(first.taskRef);
    });

    it('撤回已建立的任務會成功', async () => {
      const { provider } = setup();
      const { taskRef } = await provider.createTask({ subject, document, signers });
      await expect(provider.voidTask(taskRef)).resolves.toBeUndefined();
    });

    it('取簽署連結：有宣告不支援時以宣告的訊息拒絕，否則回傳連結', async () => {
      const { provider } = setup();
      const { taskRef } = await provider.createTask({ subject, document, signers });
      const result = provider.getSignLink(taskRef, 'tenant@example.com', 'https://app.example/contracts/7');
      if (provider.unsupported.signLink) {
        await expect(result).rejects.toThrow(provider.unsupported.signLink);
      } else {
        await expect(result).resolves.toMatch(/^https:\/\//);
      }
    });

    it('重寄：有宣告不支援時以宣告的訊息拒絕，否則成功', async () => {
      const { provider } = setup();
      const { taskRef } = await provider.createTask({ subject, document, signers });
      const result = provider.resend(taskRef);
      if (provider.unsupported.resend) {
        await expect(result).rejects.toThrow(provider.unsupported.resend);
      } else {
        await expect(result).resolves.toBeUndefined();
      }
    });

    it('空 body 是驗證 ping，不需要簽章', () => {
      const { provider } = setup();
      expect(provider.parseWebhook('', new Headers())).toEqual({ kind: 'ping' });
    });

    it.each(['signed', 'completed', 'declined', 'voided'] as const)('%s 解析成簽署事件，服務商任務編號是字串', (action) => {
      expect(parse(taskPayload(action))).toEqual({
        kind: 'event',
        taskRef: '470',
        event: { type: action },
      });
    });

    it('帶 event_email 與 reason 時放進簽署事件', () => {
      expect(parse(taskPayload('declined', { event_email: 'tenant@example.com', reason: '租金認知有落差' }))).toEqual({
        kind: 'event',
        taskRef: '470',
        event: { type: 'declined', email: 'tenant@example.com', reason: '租金認知有落差' },
      });
    });

    it('body 不是 JSON 時回無效，狀態碼 400', () => {
      expect(parse('not-json')).toEqual({ kind: 'invalid', status: 400, reason: 'invalid json' });
    });

    it.each([
      ['非 task 資源', JSON.stringify({ resource_id: 1, resource_type: 'folder', action_name: 'signed' })],
      ['缺 resource_id', JSON.stringify({ resource_type: 'task', action_name: 'signed' })],
      ['缺 action_name', JSON.stringify({ resource_id: 1, resource_type: 'task' })],
      ['未處理的事件 viewed', taskPayload('viewed')],
      ['物件原型上的名稱 constructor', taskPayload('constructor')],
      ['JSON null', 'null'],
    ])('%s 回忽略', (_label, rawBody) => {
      expect(parse(rawBody)).toEqual({ kind: 'ignored' });
    });
  });
}

describeProviderContract('Mock', () => ({
  provider: createMockProvider(),
  headersFor: () => new Headers(),
}));

// 點點簽 adapter 只換掉 HTTP 傳輸層，不打網路
describeProviderContract('點點簽', () => {
  const clientSecret = 'test-secret';
  let nextTaskId = 470;
  const request = async (path: string) => {
    if (path === '/v1/sign_tasks') return { data: { task_id: nextTaskId++ } };
    if (path.startsWith('/v1/sign_tasks/share_link')) {
      return { data: { share_link: 'https://sandbox.dottedsign.com/task?code=abc' } };
    }
    return { data: { task_id: 470 } };
  };
  return {
    provider: createDottedSignProvider({ request, clientSecret }),
    headersFor: (rawBody) =>
      new Headers({ signature: crypto.createHmac('sha256', clientSecret).update(rawBody).digest('hex') }),
  };
});

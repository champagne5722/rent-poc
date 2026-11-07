import crypto from 'crypto';
import { parseDottedSignPayload } from './dottedsign-adapter';
import type { SigningProvider } from './provider';

const UNSUPPORTED = {
  signLink: 'mock 模式無簽署連結',
  resend: 'mock 模式不寄信',
};

// Mock adapter：未設定點點簽金鑰時使用。不打外部 API。
// webhook 沿用點點簽的 payload 形狀，只是不驗證簽章。
// 部署環境的 webhook 路徑是公開的，mock 沒有 client secret 能驗簽，所以要拒收非空事件。
// 空 body 的 ping 仍回應，點點簽後台才能儲存 webhook URL。模擬簽署走 simulateEvent，不受影響。
export function createMockProvider(options: { rejectWebhookEvents?: boolean } = {}): SigningProvider {
  return {
    id: 'mock',
    mode: 'mock',
    unsupported: UNSUPPORTED,
    createTask: async ({ subject }) => ({
      taskRef: `mock-${subject.id}-${crypto.randomUUID().slice(0, 8)}`,
    }),
    getSignLink: async () => {
      throw new Error(UNSUPPORTED.signLink);
    },
    resend: async () => {
      throw new Error(UNSUPPORTED.resend);
    },
    voidTask: async () => {},
    parseWebhook: (rawBody) => {
      if (!rawBody) return { kind: 'ping' };
      if (options.rejectWebhookEvents) return { kind: 'invalid', status: 401, reason: 'mock 模式不接受 webhook 事件' };
      return parseDottedSignPayload(rawBody);
    },
  };
}

import crypto from 'crypto';
import { parseDottedSignPayload } from './dottedsign-adapter';
import type { SigningProvider } from './provider';

const UNSUPPORTED = {
  signLink: 'mock 模式無簽署連結',
  resend: 'mock 模式不寄信',
};

// Mock adapter：未設定點點簽金鑰時使用。不打外部 API。
// webhook 沿用點點簽的 payload 形狀，只是不驗證簽章。
export function createMockProvider(): SigningProvider {
  return {
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
    parseWebhook: (rawBody) => (rawBody ? parseDottedSignPayload(rawBody) : { kind: 'ping' }),
  };
}

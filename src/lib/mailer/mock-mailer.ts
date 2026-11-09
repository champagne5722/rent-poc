import { newUlid } from '../pg/ulid';
import { assertValidMessage, type Mailer, type SentMail } from './types';

// Mock adapter：測試用，不寫 log，把寄出的信留在陣列裡讓測試檢查。

export interface MockMailer extends Mailer {
  readonly sent: readonly SentMail[];
  /** 讓下一次 send 丟指定的錯，用來測寄信失敗。 */
  failNext(error?: Error): void;
  reset(): void;
}

export function createMockMailer(): MockMailer {
  const sent: SentMail[] = [];
  let pendingFailure: Error | null = null;
  return {
    sent,
    async send(message) {
      assertValidMessage(message);
      if (pendingFailure) {
        const error = pendingFailure;
        pendingFailure = null;
        throw error;
      }
      const id = newUlid();
      sent.push({ ...message, id, sentAt: new Date() });
      return { id };
    },
    async listSent() {
      return [...sent].reverse();
    },
    failNext(error = new Error('寄信失敗（測試）')) {
      pendingFailure = error;
    },
    reset() {
      sent.length = 0;
      pendingFailure = null;
    },
  };
}

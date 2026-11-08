import { newUlid } from '../pg/ulid';
import { assertValidMessage, type MailMessage, type Mailer } from './types';

// Mock adapter：測試用，不寫 log，把寄出的信留在陣列裡讓測試檢查。

export interface MockMailer extends Mailer {
  readonly sent: readonly (MailMessage & { id: string })[];
  /** 讓下一次 send 丟指定的錯，用來測寄信失敗。 */
  failNext(error?: Error): void;
  reset(): void;
}

export function createMockMailer(): MockMailer {
  const sent: (MailMessage & { id: string })[] = [];
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
      sent.push({ ...message, id });
      return { id };
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

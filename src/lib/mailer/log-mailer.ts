import { newUlid } from '../pg/ulid';
import { assertValidMessage, type MailMessage, type Mailer } from './types';

// log adapter：本機與 demo 用。寫 server log，並在記憶體留最近幾封，供 demo 的驗證碼頁讀取（ADR-0022 決議 3）。
// 只因 demo 只放測試資料才可接受，pilot 前必須換成真實寄信服務。信件不寫進資料庫。
// 記憶體只在單一程序內有效。demo 的 Cloud Run 是 max-instances=1，所以夠用。

export interface LoggedMail extends MailMessage {
  id: string;
  sentAt: Date;
}

export interface LogMailer extends Mailer {
  /** 最近的信，新的在前。 */
  recent(): readonly LoggedMail[];
}

export interface LogMailerOptions {
  /** 預設寫 console.info。 */
  sink?: (line: string) => void;
  now?: () => Date;
  /** 記憶體保留的封數，預設 50。 */
  capacity?: number;
}

export function createLogMailer(options: LogMailerOptions = {}): LogMailer {
  const sink = options.sink ?? ((line: string) => console.info(line));
  const now = options.now ?? (() => new Date());
  const capacity = options.capacity ?? 50;
  const mails: LoggedMail[] = [];
  return {
    async send(message) {
      assertValidMessage(message);
      const mail: LoggedMail = { ...message, id: newUlid(), sentAt: now() };
      mails.unshift(mail);
      if (mails.length > capacity) mails.length = capacity;
      sink(`[mailer:log] ${mail.kind} -> ${mail.to} | ${mail.subject}\n${mail.text}`);
      return { id: mail.id };
    },
    recent: () => [...mails],
  };
}

import { afterEach, describe, expect, it } from 'vitest';
import { getMailer, mailerAdapterName, recentLoggedMail, setMailer } from './index';
import { createMockMailer } from './mock-mailer';

afterEach(() => setMailer(undefined));

describe('mailerAdapterName', () => {
  it('本機與測試沒設定時用 log', () => {
    expect(mailerAdapterName({})).toBe('log');
    expect(mailerAdapterName({ NODE_ENV: 'development' })).toBe('log');
  });
  it('明確設定就用設定的值', () => {
    expect(mailerAdapterName({ MAILER_ADAPTER: ' log ', NODE_ENV: 'production' })).toBe('log');
  });
  it('正式環境沒設定回傳 null，不退回 log', () => {
    expect(mailerAdapterName({ NODE_ENV: 'production' })).toBeNull();
    expect(mailerAdapterName({ NODE_ENV: 'production', MAILER_ADAPTER: '  ' })).toBeNull();
  });
});

describe('getMailer 與 demo 驗證碼頁的資料', () => {
  it('正式環境沒明確設定：不給 mailer，驗證碼頁的資料也是 null', () => {
    expect(() => getMailer({ NODE_ENV: 'production' })).toThrow(/MAILER_ADAPTER/);
    expect(recentLoggedMail({ NODE_ENV: 'production' })).toBeNull();
  });
  it('正式環境明確設成 log：兩者都可用', async () => {
    const env = { NODE_ENV: 'production', MAILER_ADAPTER: 'log' };
    await getMailer(env).send({ to: 'a@example.com', subject: 's', text: 't', kind: 'auth.otp' });
    expect(recentLoggedMail(env)?.some((m) => m.to === 'a@example.com')).toBe(true);
  });
  it('不存在的 adapter 一律拒絕，不默默退回 log', () => {
    expect(() => getMailer({ MAILER_ADAPTER: 'smtp' })).toThrow(/不存在/);
    expect(recentLoggedMail({ MAILER_ADAPTER: 'smtp' })).toBeNull();
  });
  it('測試換成別的 adapter 時，驗證碼頁的資料是 null', () => {
    setMailer(createMockMailer());
    expect(recentLoggedMail({})).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { createLogMailer } from './log-mailer';
import { createMockMailer } from './mock-mailer';
import type { MailMessage, Mailer } from './types';

// 契約測試：兩個 adapter 必須通過同一組（比照簽署服務商的契約測試）。

const message: MailMessage = {
  to: 'owner@example.com',
  subject: '登入驗證碼',
  text: '您的驗證碼是 123456',
  kind: 'auth.otp',
};

function contract(name: string, make: () => Mailer) {
  describe(`Mailer 契約：${name}`, () => {
    it('寄出後回傳非空的 id，兩封信的 id 不同', async () => {
      const mailer = make();
      const a = await mailer.send(message);
      const b = await mailer.send(message);
      expect(a.id).not.toBe('');
      expect(a.id).not.toBe(b.id);
    });

    it.each([
      ['收件人不是 email', { to: 'not-an-email' }],
      ['收件人是多個', { to: 'a@example.com,b@example.com' }],
      ['主旨為空', { subject: '  ' }],
      ['主旨含換行', { subject: '登入\r\nBcc: x@example.com' }],
      ['本文為空', { text: '' }],
      ['種類格式不合', { kind: 'OTP' }],
      ['寄件名義為空', { from: '  ' }],
      ['寄件名義含換行', { from: '管理公司\r\nBcc: x@example.com' }],
    ])('拒絕輸入不合格的信：%s', async (_label, patch) => {
      const mailer = make();
      await expect(mailer.send({ ...message, ...patch })).rejects.toThrow();
      expect(await mailer.listSent()).toEqual([]);
    });

    // MIL-120：寄件紀錄。寄件名義由呼叫端傳入，紀錄看得到
    it('查得到寄件紀錄：新的在前，帶寄件名義與寄出時間', async () => {
      const mailer = make();
      const first = await mailer.send({ ...message, from: '大安管理公司' });
      const second = await mailer.send({ ...message, to: 'second@example.com' });
      const sent = await mailer.listSent();
      expect(sent.map((m) => m.id)).toEqual([second.id, first.id]);
      expect(sent[1]).toMatchObject({ to: 'owner@example.com', from: '大安管理公司', kind: 'auth.otp', subject: '登入驗證碼' });
      expect(sent[0].from).toBeUndefined();
      expect(sent[0].sentAt).toBeInstanceOf(Date);
    });

    it('listSent 回傳複本，改它不影響內部', async () => {
      const mailer = make();
      await mailer.send(message);
      const copy = [...(await mailer.listSent())];
      copy.length = 0;
      expect(await mailer.listSent()).toHaveLength(1);
    });
  });
}

contract('log', () => createLogMailer({ sink: () => undefined }));
contract('mock', () => createMockMailer());

describe('log adapter', () => {
  it('把信寫進 sink，並在記憶體留最近的信，新的在前', async () => {
    const lines: string[] = [];
    const mailer = createLogMailer({ sink: (l) => lines.push(l), now: () => new Date('2026-11-09T10:00:00Z') });
    await mailer.send(message);
    await mailer.send({ ...message, to: 'second@example.com' });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('123456');
    expect(mailer.recent().map((m) => m.to)).toEqual(['second@example.com', 'owner@example.com']);
    expect(mailer.recent()[0].sentAt).toEqual(new Date('2026-11-09T10:00:00Z'));
  });

  it('超過容量時丟掉最舊的', async () => {
    const mailer = createLogMailer({ sink: () => undefined, capacity: 2 });
    for (const to of ['a@example.com', 'b@example.com', 'c@example.com']) await mailer.send({ ...message, to });
    expect(mailer.recent().map((m) => m.to)).toEqual(['c@example.com', 'b@example.com']);
  });

  it('不合格的信不寫 log、不進記憶體', async () => {
    const lines: string[] = [];
    const mailer = createLogMailer({ sink: (l) => lines.push(l) });
    await expect(mailer.send({ ...message, to: 'bad' })).rejects.toThrow();
    expect(lines).toEqual([]);
    expect(mailer.recent()).toEqual([]);
  });
});

describe('Mock adapter', () => {
  it('記下寄出的信，failNext 讓下一次寄信失敗且不記錄', async () => {
    const mailer = createMockMailer();
    await mailer.send(message);
    mailer.failNext(new Error('smtp down'));
    await expect(mailer.send(message)).rejects.toThrow('smtp down');
    await mailer.send({ ...message, to: 'later@example.com' });
    expect(mailer.sent.map((m) => m.to)).toEqual(['owner@example.com', 'later@example.com']);
  });
});

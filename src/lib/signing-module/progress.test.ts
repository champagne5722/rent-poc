import { describe, expect, it } from 'vitest';
import { advanceProgress } from './progress';
import type { ProgressSnapshot, SignerRecord, SignerStatus, SignTaskStatus } from './sign-task-store';
import type { SignerRole } from '../types';

const ROLES: SignerRole[] = ['party_b', 'practitioner', 'party_a'];

function signer(index: number, status: SignerStatus = 'pending', signedAt: string | null = null): SignerRecord {
  return { role: ROLES[index], name: `簽署人${index}`, email: `s${index}@example.com`, status, signedAt };
}

const brief = (index: number) => ({ role: ROLES[index], name: `簽署人${index}`, email: `s${index}@example.com` });

function snapshot(statuses: SignerStatus[], status: SignTaskStatus = 'in_progress'): ProgressSnapshot {
  return {
    status,
    signers: statuses.map((s, i) => signer(i, s, s === 'signed' ? '2026-11-08 10:00:00' : null)),
  };
}

const statuses = (result: ReturnType<typeof advanceProgress>) =>
  result.accepted ? result.signers.map((s) => s.status) : null;

describe('advanceProgress：簽署人已簽', () => {
  it.each([
    { label: '1 位，唯一一位簽署', before: ['pending'], who: 0, after: ['signed'], next: null },
    { label: '2 位，第一位簽署', before: ['pending', 'pending'], who: 0, after: ['signed', 'pending'], next: 1 },
    { label: '2 位，最後一位簽署', before: ['signed', 'pending'], who: 1, after: ['signed', 'signed'], next: null },
    {
      label: '3 位，第一位簽署',
      before: ['pending', 'pending', 'pending'],
      who: 0,
      after: ['signed', 'pending', 'pending'],
      next: 1,
    },
    {
      label: '3 位，第二位簽署',
      before: ['signed', 'pending', 'pending'],
      who: 1,
      after: ['signed', 'signed', 'pending'],
      next: 2,
    },
    {
      label: '3 位，最後一位簽署',
      before: ['signed', 'signed', 'pending'],
      who: 2,
      after: ['signed', 'signed', 'signed'],
      next: null,
    },
  ] as const)('$label', ({ before, who, after, next }) => {
    const result = advanceProgress(snapshot([...before]), { type: 'signed', email: `s${who}@example.com` });

    expect(statuses(result)).toEqual(after);
    expect(result).toMatchObject({
      accepted: true,
      status: 'in_progress',
      outcome: { type: 'signer_signed', signer: brief(who), next: next === null ? null : brief(next) },
    });
  });

  it('email 比對不分大小寫，也忽略前後空白', () => {
    const result = advanceProgress(snapshot(['pending', 'pending']), { type: 'signed', email: ' S0@Example.COM ' });
    expect(statuses(result)).toEqual(['signed', 'pending']);
  });

  it('第一位的重試不會把第二位標為已簽', () => {
    const result = advanceProgress(snapshot(['signed', 'pending']), { type: 'signed', email: 's0@example.com' });
    expect(result).toEqual({ accepted: false, reason: 'email_mismatch' });
  });

  it('還沒輪到的簽署人不會被標為已簽', () => {
    const result = advanceProgress(snapshot(['pending', 'pending']), { type: 'signed', email: 's1@example.com' });
    expect(result).toEqual({ accepted: false, reason: 'email_mismatch' });
  });

  it('事件沒有 email 時不接受', () => {
    const result = advanceProgress(snapshot(['pending', 'pending']), { type: 'signed' });
    expect(result).toEqual({ accepted: false, reason: 'email_mismatch' });
  });

  it('全員都已簽但任務還在進行中時，重複的簽署人已簽不接受', () => {
    const result = advanceProgress(snapshot(['signed', 'signed']), { type: 'signed', email: 's1@example.com' });
    expect(result).toEqual({ accepted: false, reason: 'email_mismatch' });
  });

  it('有事件時間時記為簽署時間', () => {
    const result = advanceProgress(snapshot(['pending']), {
      type: 'signed',
      email: 's0@example.com',
      occurredAt: '2026-11-08T02:00:00.000Z',
    });
    expect(result.accepted && result.signers[0].signedAt).toBe('2026-11-08T02:00:00.000Z');
  });
});

describe('advanceProgress：全員完成', () => {
  it.each([
    { label: '1 位', before: ['pending'], after: ['signed'] },
    { label: '2 位，簽署人已簽沒有先到', before: ['pending', 'pending'], after: ['signed', 'signed'] },
    { label: '2 位，最後一位已簽', before: ['signed', 'signed'], after: ['signed', 'signed'] },
    { label: '3 位，只有第一位已簽', before: ['signed', 'pending', 'pending'], after: ['signed', 'signed', 'signed'] },
  ] as const)('$label：未簽者全部標為已簽，任務完成', ({ before, after }) => {
    const result = advanceProgress(snapshot([...before]), { type: 'completed' });

    expect(statuses(result)).toEqual(after);
    expect(result).toMatchObject({ accepted: true, status: 'completed', outcome: { type: 'completed' } });
  });

  it('已簽者的簽署時間不變', () => {
    const result = advanceProgress(snapshot(['signed', 'pending']), {
      type: 'completed',
      occurredAt: '2026-11-08T02:00:00.000Z',
    });
    expect(result.accepted && result.signers.map((s) => s.signedAt)).toEqual([
      '2026-11-08 10:00:00',
      '2026-11-08T02:00:00.000Z',
    ]);
  });
});

describe('advanceProgress：拒簽', () => {
  it.each([
    { label: '1 位', before: ['pending'], after: ['declined'], who: 0 },
    { label: '2 位，第一位拒簽', before: ['pending', 'pending'], after: ['declined', 'pending'], who: 0 },
    { label: '2 位，第二位拒簽', before: ['signed', 'pending'], after: ['signed', 'declined'], who: 1 },
    {
      label: '3 位，第三位拒簽',
      before: ['signed', 'signed', 'pending'],
      after: ['signed', 'signed', 'declined'],
      who: 2,
    },
  ] as const)('$label：當前簽署人標為拒簽，任務已拒簽', ({ before, after, who }) => {
    const result = advanceProgress(snapshot([...before]), { type: 'declined', reason: '想再考慮' });

    expect(statuses(result)).toEqual(after);
    expect(result).toMatchObject({
      accepted: true,
      status: 'declined',
      outcome: { type: 'declined', signer: brief(who), reason: '想再考慮' },
    });
  });

  it('全員都已簽時沒有當前簽署人，任務仍標為已拒簽', () => {
    const result = advanceProgress(snapshot(['signed', 'signed']), { type: 'declined' });
    expect(statuses(result)).toEqual(['signed', 'signed']);
    expect(result).toMatchObject({ accepted: true, status: 'declined', outcome: { type: 'declined', signer: null } });
  });
});

describe('advanceProgress：撤回', () => {
  it.each([
    { label: '1 位', before: ['pending'] },
    { label: '2 位', before: ['signed', 'pending'] },
    { label: '3 位', before: ['signed', 'signed', 'pending'] },
  ] as const)('$label：任務已撤回，簽署人狀態不變', ({ before }) => {
    const result = advanceProgress(snapshot([...before]), { type: 'voided' });

    expect(statuses(result)).toEqual(before);
    expect(result).toMatchObject({ accepted: true, status: 'voided', outcome: { type: 'voided' } });
  });
});

describe('advanceProgress：任務結束後', () => {
  const ended = ['completed', 'declined', 'voided'] as const;
  const events = [
    { type: 'signed', email: 's0@example.com' },
    { type: 'completed' },
    { type: 'declined' },
    { type: 'voided' },
  ] as const;

  it.each(ended.flatMap((status) => events.map((event) => ({ status, event }))))(
    '$status 不接受 $event.type',
    ({ status, event }) => {
      expect(advanceProgress(snapshot(['pending'], status), event)).toEqual({ accepted: false, reason: 'task_ended' });
    }
  );
});

import type { CurrentSigner, SigningEvent } from './provider';
import type { ProgressSnapshot, SignerRecord, SignTaskStatus } from './sign-task-store';

// 簽署進度的推進規則（MIL-52）。純函式：沒有 I/O，簽署人數與順序都由輸入決定。

// 推進的結果。簽署標的的訂閱者依結果決定自己的狀態。
export type ProgressOutcome =
  | { type: 'signer_signed'; signer: CurrentSigner; next: CurrentSigner | null }
  | { type: 'completed' }
  | { type: 'declined'; signer: CurrentSigner | null; reason?: string }
  | { type: 'voided' };

export type ProgressAdvance =
  | { accepted: true; status: SignTaskStatus; signers: SignerRecord[]; outcome: ProgressOutcome }
  | { accepted: false; reason: 'task_ended' | 'email_mismatch' };

export function advanceProgress(progress: ProgressSnapshot, event: SigningEvent): ProgressAdvance {
  if (progress.status !== 'in_progress') return { accepted: false, reason: 'task_ended' };

  const currentIndex = progress.signers.findIndex((s) => s.status === 'pending');
  const current = progress.signers[currentIndex];
  const occurredAt = event.occurredAt ?? null;

  switch (event.type) {
    case 'signed': {
      // 點點簽沒有事件 ID 且會重試，所以靠 email 分辨重試與下一位的簽署（ADR-0010 決議 9）
      if (!current || !sameEmail(current.email, event.email)) return { accepted: false, reason: 'email_mismatch' };
      const next = progress.signers[currentIndex + 1];
      return {
        accepted: true,
        status: 'in_progress',
        signers: replaceAt(progress.signers, currentIndex, { status: 'signed', signedAt: occurredAt }),
        outcome: { type: 'signer_signed', signer: toCurrentSigner(current), next: next ? toCurrentSigner(next) : null },
      };
    }
    case 'completed':
      return {
        accepted: true,
        status: 'completed',
        signers: progress.signers.map((s) =>
          s.status === 'signed' ? s : { ...s, status: 'signed', signedAt: s.signedAt ?? occurredAt }
        ),
        outcome: { type: 'completed' },
      };
    case 'declined':
      return {
        accepted: true,
        status: 'declined',
        signers: current ? replaceAt(progress.signers, currentIndex, { status: 'declined' }) : progress.signers,
        outcome: { type: 'declined', signer: current ? toCurrentSigner(current) : null, reason: event.reason },
      };
    case 'voided':
      return { accepted: true, status: 'voided', signers: progress.signers, outcome: { type: 'voided' } };
  }
}

function sameEmail(expected: string, actual: string | undefined): boolean {
  return actual !== undefined && normalizeEmail(expected) === normalizeEmail(actual);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toCurrentSigner({ role, name, email }: SignerRecord): CurrentSigner {
  return { role, name, email };
}

function replaceAt(signers: SignerRecord[], index: number, patch: Partial<SignerRecord>): SignerRecord[] {
  return signers.map((s, i) => (i === index ? { ...s, ...patch } : s));
}

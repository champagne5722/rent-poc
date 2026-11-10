import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContractSubscriber } from '../contract-signing';
import { createLocalFileStore } from '../file-store/local-file-store';
import { withTx } from '../pg/database';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import { newUlid } from '../pg/ulid';
import { buildSignerSequence, DOCUMENT_TYPES, routeSignatures } from '../signature-routing';
import type { SignerRole } from '../types';
import type { SigningDb } from './db';
import { createMockProvider } from './mock-adapter';
import { createSigningModule } from './module';
import { SIGNING_SUBJECT_TYPES, type SignableDocument, type Signer, type SigningProvider, type SigningSubject } from './provider';
import { createDocumentSubjectStub, type DocumentSubjectStub } from './test-subjects.fixture';

// 簽署標的擴充為四種（MIL-131，ADR-0051 決議 1、13）：點交證明、押金結算單、退還證明。
// 用最小的測試訂閱者，經簽署模組的公開介面和 Mock adapter 走完送簽、完成、拒簽、撤回。
// 簽署序列由 routeSignatures 與 buildSignerSequence 產生，不手寫。

let kit: RouteDb;
let dataDir: string;

beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(async () => {
  await kit.reset();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-subjects-'));
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const dbA = (): SigningDb => ({
  requestOrg: async () => ({ kind: 'org', orgId: kit.orgA }),
  inOrg: (ctx, fn) => withTx(ctx, fn),
  inControl: (fn) => withTx({ kind: 'control' }, fn),
});

const NEW_TYPES = ['handover_certificate', 'deposit_settlement', 'deposit_refund_certificate'] as const;
type NewType = (typeof NEW_TYPES)[number];

const document: SignableDocument = {
  fileName: '測試文件',
  pdf: new Uint8Array([37, 80, 68, 70]),
  pageSize: { width: 595.28, height: 841.89 },
};

const PEOPLE: Record<SignerRole, { name: string; email: string }> = {
  party_a: { name: '林屋主', email: 'owner@example.com' },
  party_b: { name: '王租客', email: 'tenant@example.com' },
  practitioner: { name: '陳經理', email: 'practitioner@example.com' },
};

/** 代管案件的簽署序列，由規則表產生：點交證明與退還證明三位，結算單兩位。 */
function signersFor(type: NewType): Signer[] {
  const route = routeSignatures({ documentType: type, caseKind: 'lease', businessType: 'managed' });
  if (route.kind !== 'sequence') throw new Error(`規則表沒有給出 ${type} 的序列`);
  const assignees = Object.fromEntries(route.plan.seats.map((seat) => [seat.ruleId, PEOPLE[seat.role]]));
  const built = buildSignerSequence(route.plan, assignees, []);
  if (!built.ok) throw new Error(`缺少簽署人：${built.missing.join(', ')}`);
  return built.signers;
}

const refusal = (status: number, message: string) => expect.objectContaining({ name: 'SigningRefusal', status, message });

// 四種標的各註冊一個訂閱者，與正式註冊的形狀相同
function setup(provider: SigningProvider = createMockProvider()) {
  const stubs = Object.fromEntries(NEW_TYPES.map((type) => [type, createDocumentSubjectStub(type)])) as Record<
    NewType,
    DocumentSubjectStub
  >;
  const signing = createSigningModule({
    provider,
    subscribers: {
      contract: createContractSubscriber(),
      handover_certificate: stubs.handover_certificate.subscriber,
      deposit_settlement: stubs.deposit_settlement.subscriber,
      deposit_refund_certificate: stubs.deposit_refund_certificate.subscriber,
    },
    files: createLocalFileStore(dataDir),
    db: dbA(),
  });
  const subjectOf = (type: NewType): SigningSubject => {
    const subject = { type, id: newUlid() };
    stubs[type].add(subject.id);
    return subject;
  };
  return { signing, stubs, subjectOf };
}

describe('簽署標的的種類', () => {
  it('有合約、點交證明、押金結算單、退還證明四種', () => {
    expect([...SIGNING_SUBJECT_TYPES]).toEqual([
      'contract',
      'handover_certificate',
      'deposit_settlement',
      'deposit_refund_certificate',
    ]);
  });

  it('規則表的文件類型與簽署標的的種類用同一組識別字', () => {
    const documentTypesOfSubjects = DOCUMENT_TYPES.filter((t) => t !== 'lease' && t !== 'management');
    expect([...documentTypesOfSubjects]).toEqual(SIGNING_SUBJECT_TYPES.filter((t) => t !== 'contract'));
  });
});

// 預期值手寫自 ADR-0018 決議 5 的代管列，用來確認簽署序列真的來自規則表
const EXPECTED_ROLES: Record<NewType, SignerRole[]> = {
  handover_certificate: ['party_b', 'party_a', 'practitioner'],
  deposit_settlement: ['party_b', 'party_a'],
  deposit_refund_certificate: ['party_b', 'party_a', 'practitioner'],
};

describe.each(NEW_TYPES)('%s 經簽署模組走完', (type) => {
  it('簽署序列來自規則表', () => {
    expect(signersFor(type).map((s) => s.role)).toEqual(EXPECTED_ROLES[type]);
  });

  it('送簽到全員完成：訂閱者依序收到事件，已簽 PDF 以簽署任務為鍵保存', async () => {
    const { signing, stubs, subjectOf } = setup();
    const subject = subjectOf(type);
    const signers = signersFor(type);

    await signing.send(subject, document, signers);
    expect(stubs[type].statusOf(subject.id)).toBe('signing');
    await expect(signing.getProgress(subject)).resolves.toMatchObject({
      status: 'in_progress',
      currentSigner: { role: 'party_b' },
    });

    for (let i = 0; i < signers.length; i++) await signing.simulateEvent(subject, 'signed');
    await signing.simulateEvent(subject, 'completed');

    expect(stubs[type].statusOf(subject.id)).toBe('completed');
    expect(stubs[type].log.map((entry) => entry[0])).toEqual([
      'sent',
      ...signers.map(() => 'signer_signed'),
      'completed',
      'afterCompleted',
    ]);
    await expect(signing.getProgress(subject)).resolves.toMatchObject({ status: 'completed' });

    const files = await signing.listFiles(subject);
    expect(files.find((f) => f.kind === 'signed_pdf')).toMatchObject({ status: 'saved' });
    const downloaded = await signing.downloadFile(subject, 'signed_pdf');
    expect(downloaded.fileName).toBe(`${type}-${subject.id}-signed.pdf`);
    expect([...downloaded.bytes]).toEqual([...document.pdf]);
  });

  it('撤回：簽署任務與標的狀態都轉為已撤回', async () => {
    const { signing, stubs, subjectOf } = setup();
    const subject = subjectOf(type);
    await signing.send(subject, document, signersFor(type));
    await signing.simulateEvent(subject, 'signed');

    await signing.voidTask(subject);

    await expect(signing.getProgress(subject)).resolves.toMatchObject({ status: 'voided' });
    expect(stubs[type].statusOf(subject.id)).toBe('voided');
  });

  it('拒簽：標的狀態轉為已拒簽，之後不能再撤回', async () => {
    const { signing, stubs, subjectOf } = setup();
    const subject = subjectOf(type);
    await signing.send(subject, document, signersFor(type));

    await signing.simulateEvent(subject, 'declined');

    expect(stubs[type].statusOf(subject.id)).toBe('declined');
    await expect(signing.voidTask(subject)).rejects.toMatchObject({ name: 'SigningRefusal', status: 409 });
  });

  it('沒有簽署任務時的撤回交給訂閱者', async () => {
    const { signing, stubs, subjectOf } = setup();
    const subject = subjectOf(type);

    await signing.voidTask(subject);

    expect(stubs[type].log).toEqual([['voidWithoutTask']]);
  });

  it('一個標的最多一個簽署任務，撤回後也不能在同一標的重送', async () => {
    const { signing, subjectOf } = setup();
    const subject = subjectOf(type);
    await signing.send(subject, document, signersFor(type));

    await expect(signing.send(subject, document, signersFor(type))).rejects.toEqual(
      refusal(409, '這個簽署標的已有簽署任務'),
    );
    await signing.voidTask(subject);
    await expect(signing.send(subject, document, signersFor(type))).rejects.toEqual(
      refusal(409, '這個簽署標的已有簽署任務'),
    );
  });

  it('不存在的標的以訂閱者的名稱回 404', async () => {
    const { signing, stubs } = setup();

    await expect(signing.send({ type, id: newUlid() }, document, signersFor(type))).rejects.toEqual(
      refusal(404, `${stubs[type].subscriber.label}不存在`),
    );
  });

  it('取簽署連結與重寄對準當前簽署人', async () => {
    const getSignLink = vi.fn<SigningProvider['getSignLink']>(async () => 'https://sign.example/abc');
    const resend = vi.fn<SigningProvider['resend']>(async () => {});
    const { signing, subjectOf } = setup({ ...createMockProvider(), unsupported: {}, getSignLink, resend });
    const subject = subjectOf(type);
    await signing.send(subject, document, signersFor(type));

    await expect(signing.getSignLink(subject)).resolves.toMatchObject({
      signer: { role: 'party_b', email: PEOPLE.party_b.email },
      url: 'https://sign.example/abc',
    });
    await signing.resend(subject);

    expect(getSignLink).toHaveBeenCalledWith(expect.stringMatching(/^mock-/), PEOPLE.party_b.email, undefined);
    expect(resend).toHaveBeenCalledTimes(1);
  });
});

describe('webhook 依任務找到標的種類', () => {
  it('三種標的同時在簽署中時，事件只交給任務所屬標的的訂閱者', async () => {
    let incoming = '';
    const provider: SigningProvider = {
      ...createMockProvider(),
      parseWebhook: () => ({ kind: 'event', taskRef: incoming, event: { type: 'completed' } }),
    };
    const { signing, stubs, subjectOf } = setup(provider);
    const subjects = NEW_TYPES.map(subjectOf);
    for (const subject of subjects) await signing.send(subject, document, signersFor(subject.type as NewType));

    const [handover, settlement, refund] = subjects;
    const task = await withTx({ kind: 'org', orgId: kit.orgA }, (tx) =>
      tx.query<{ provider_task_ref: string }>(
        'SELECT provider_task_ref FROM org.sign_tasks WHERE subject_type = $1 AND subject_id = $2',
        [settlement.type, settlement.id],
      ),
    );
    incoming = task.rows[0].provider_task_ref;

    await expect(signing.ingestWebhook('{}', new Headers())).resolves.toEqual({ status: 200, body: { ok: true } });

    expect(stubs.deposit_settlement.statusOf(settlement.id)).toBe('completed');
    expect(stubs.handover_certificate.statusOf(handover.id)).toBe('signing');
    expect(stubs.deposit_refund_certificate.statusOf(refund.id)).toBe('signing');
    expect(stubs.handover_certificate.log.map((e) => e[0])).toEqual(['sent']);
    expect(stubs.deposit_refund_certificate.log.map((e) => e[0])).toEqual(['sent']);
  });

  it('沒有註冊訂閱者的種類回 404，不會被當成合約處理', async () => {
    const signing = createSigningModule({
      provider: createMockProvider(),
      subscribers: { contract: createContractSubscriber() },
      files: createLocalFileStore(dataDir),
      db: dbA(),
    });

    await expect(
      signing.send({ type: 'deposit_settlement', id: newUlid() }, document, signersFor('deposit_settlement')),
    ).rejects.toEqual(refusal(404, '不支援的簽署標的'));
  });
});

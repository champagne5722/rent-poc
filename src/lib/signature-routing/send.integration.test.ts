import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContractSubscriber } from '../contract-signing';
import { createContract, getContract, listContractEvents } from '../contracts';
import { withTx } from '../pg/database';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import type { OrgTx } from '../pg/with-tx';
import { prepareContractSigners } from '../signing';
import { createMockProvider } from '../signing-module/mock-adapter';
import { createSigningModule } from '../signing-module/module';
import type { ContractFields, SignatureField } from '../types';
import { loadContractRoutingFacts } from './repository';

// 送簽經規則表，用 Mock adapter 走完一份自管租賃合約：狀態與歷程與規則表接上之前相同。
// 合約與簽署任務都在 PostgreSQL（PGlite，MIL-85）。

let kit: RouteDb;
let dataDir: string;

beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(async () => {
  await kit.reset();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-send-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const inA = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: kit.orgA }, fn);

const FIELDS = {
  landlordName: '林房東',
  landlordEmail: 'landlord@example.com',
  tenantName: '王租客',
  tenantEmail: 'tenant@example.com',
};
const SIGNATURE_FIELDS: SignatureField[] = [
  { id: 'f1', signer: 'party_a', page: 1, x: 0.6, y: 0.8, w: 0.2, h: 0.1 },
  { id: 'f2', signer: 'party_b', page: 1, x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
];
const document = {
  fileName: '租賃合約-測試物件',
  pdf: new Uint8Array([37, 80, 68, 70]),
  pageSize: { width: 595.28, height: 841.89 },
};

async function sendNewContract(fields: object = FIELDS) {
  const id = await inA((tx) =>
    createContract(tx, { property_id: null, fields: fields as ContractFields, signature_fields: SIGNATURE_FIELDS }),
  );
  const routing = await inA((tx) => loadContractRoutingFacts(tx, id));
  if (!routing.ok) throw new Error(routing.reason);
  const prepared = prepareContractSigners((await inA((tx) => getContract(tx, id)))!, routing.facts);
  if (!prepared.ok) throw new Error(prepared.error);

  const signing = createSigningModule({
    provider: createMockProvider(),
    subscribers: { contract: createContractSubscriber() },
    dataDir,
    db: {
      requestOrg: async () => ({ kind: 'org', orgId: kit.orgA }),
      inOrg: (ctx, fn) => withTx(ctx, fn),
      inControl: (fn) => withTx({ kind: 'control' }, fn),
    },
  });
  const subject = { type: 'contract', id } as const;
  await signing.send(subject, document, prepared.signers);
  return { id, subject, signing };
}

describe('自管租賃合約經規則表送簽，用 Mock 走完', () => {
  it('乙方先簽、甲方後簽，狀態與歷程與改動前相同', async () => {
    const { id, subject, signing } = await sendNewContract();
    expect((await inA((tx) => getContract(tx, id)))?.status).toBe('awaiting_tenant');

    await signing.simulateEvent(subject, 'signed');
    expect((await inA((tx) => getContract(tx, id)))?.status).toBe('awaiting_landlord');

    await signing.simulateEvent(subject, 'signed');
    await signing.simulateEvent(subject, 'completed');
    expect((await inA((tx) => getContract(tx, id)))?.status).toBe('completed');

    expect((await inA((tx) => listContractEvents(tx, id))).map((e) => [e.type, e.actor])).toEqual([
      ['created', 'landlord'],
      ['sent', 'landlord'],
      ['signer_signed', 'party_b'],
      // 最後一位簽完不寫歷程，等全員完成事件（transitions.ts 現況）
      ['completed', 'system'],
    ]);
  });

  it('簽署進度的順序是乙方、甲方', async () => {
    const { subject, signing } = await sendNewContract();
    const progress = await signing.getProgress(subject);
    expect(progress?.signers.map((s) => [s.role, s.email])).toEqual([
      ['party_b', 'tenant@example.com'],
      ['party_a', 'landlord@example.com'],
    ]);
  });

  it('分流條件快照指向包租時，沒有指派執業人員就不能送簽', async () => {
    const id = await inA((tx) =>
      createContract(tx, {
        property_id: null,
        fields: {
          ...FIELDS,
          routing: { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: false },
        } as ContractFields,
        signature_fields: SIGNATURE_FIELDS,
      }),
    );
    const routing = await inA((tx) => loadContractRoutingFacts(tx, id));
    if (!routing.ok) throw new Error(routing.reason);
    const prepared = prepareContractSigners((await inA((tx) => getContract(tx, id)))!, routing.facts);
    expect(prepared).toEqual({ ok: false, status: 400, error: '請先指派執業人員' });
  });
});

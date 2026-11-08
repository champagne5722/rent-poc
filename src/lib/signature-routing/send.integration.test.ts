import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContractSubscriber } from '../contract-signing';
import { ensureSchema, getContract, insertContractWithEvent, listContractEvents, setDb } from '../db';
import { prepareContractSigners } from '../signing';
import { createMockProvider } from '../signing-module/mock-adapter';
import { createSigningModule } from '../signing-module/module';
import { loadContractRoutingFacts } from './repository';

// 送簽經規則表，用 Mock adapter 走完一份自管租賃合約：狀態與歷程與規則表接上之前相同。

let db: Database.Database;
let dataDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  ensureSchema(db);
  setDb(db);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-send-'));
});

afterEach(() => {
  setDb(null);
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const FIELDS = {
  landlordName: '林房東',
  landlordEmail: 'landlord@example.com',
  tenantName: '王租客',
  tenantEmail: 'tenant@example.com',
};
const SIGNATURE_FIELDS = [
  { id: 'f1', signer: 'party_a', page: 1, x: 0.6, y: 0.8, w: 0.2, h: 0.1 },
  { id: 'f2', signer: 'party_b', page: 1, x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
];
const document = {
  fileName: '租賃合約-測試物件',
  pdf: new Uint8Array([37, 80, 68, 70]),
  pageSize: { width: 595.28, height: 841.89 },
};

async function sendNewContract(fields: object = FIELDS) {
  const id = insertContractWithEvent(
    { property_id: null, fields: JSON.stringify(fields), signature_fields: JSON.stringify(SIGNATURE_FIELDS) },
    { type: 'created', actor: 'landlord' },
    db,
  );
  const routing = await loadContractRoutingFacts(id);
  if (!routing.ok) throw new Error(routing.reason);
  const prepared = prepareContractSigners(getContract(id)!, routing.facts);
  if (!prepared.ok) throw new Error(prepared.error);

  const signing = createSigningModule({
    provider: createMockProvider(),
    subscribers: { contract: createContractSubscriber() },
    dataDir,
  });
  const subject = { type: 'contract', id } as const;
  await signing.send(subject, document, prepared.signers);
  return { id, subject, signing };
}

describe('自管租賃合約經規則表送簽，用 Mock 走完', () => {
  it('乙方先簽、甲方後簽，狀態與歷程與改動前相同', async () => {
    const { id, subject, signing } = await sendNewContract();
    expect(getContract(id)?.status).toBe('awaiting_tenant');

    await signing.simulateEvent(subject, 'signed');
    expect(getContract(id)?.status).toBe('awaiting_landlord');

    await signing.simulateEvent(subject, 'signed');
    await signing.simulateEvent(subject, 'completed');
    expect(getContract(id)?.status).toBe('completed');

    expect(listContractEvents(id, db).map((e) => [e.type, e.actor])).toEqual([
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
    const id = insertContractWithEvent(
      {
        property_id: null,
        fields: JSON.stringify({
          ...FIELDS,
          routing: { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: false },
        }),
        signature_fields: JSON.stringify(SIGNATURE_FIELDS),
      },
      { type: 'created', actor: 'landlord' },
      db,
    );
    const routing = await loadContractRoutingFacts(id);
    if (!routing.ok) throw new Error(routing.reason);
    const prepared = prepareContractSigners(getContract(id)!, routing.facts);
    expect(prepared).toEqual({ ok: false, status: 400, error: '請先指派執業人員' });
  });
});

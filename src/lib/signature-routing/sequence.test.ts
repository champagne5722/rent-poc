import { describe, expect, it } from 'vitest';
import type { SignatureField } from '../types';
import { buildSignerSequence } from './sequence';
import { routeSignatures, type SignaturePlan } from './index';

function planOf(facts: Parameters<typeof routeSignatures>[0]): SignaturePlan {
  const route = routeSignatures(facts);
  if (route.kind !== 'sequence') throw new Error('預期有簽署序列');
  return route.plan;
}

const field = (id: string, signer: SignatureField['signer'], page = 0, slot?: string): SignatureField => ({
  id,
  signer,
  page,
  x: 0.1,
  y: 0.8,
  w: 0.2,
  h: 0.1,
  ...(slot ? { slot } : {}),
});

const selfManaged = planOf({
  documentType: 'lease',
  caseKind: 'lease',
  businessType: 'self_managed',
  brokerMediated: false,
});

describe('buildSignerSequence：兩方租賃合約', () => {
  it('乙方在前、甲方在後，各自帶自己的簽署區域與驗證方式', () => {
    const b = field('f1', 'party_b');
    const a = field('f2', 'party_a', 1);
    const result = buildSignerSequence(
      selfManaged,
      {
        'lease.self_managed.party_a': { name: '林房東', email: 'landlord@example.com' },
        'lease.self_managed.party_b': { name: '王租客', email: 'tenant@example.com' },
      },
      [a, b],
    );

    expect(result).toEqual({
      ok: true,
      signers: [
        { role: 'party_b', name: '王租客', email: 'tenant@example.com', verifyMethods: ['email'], signatureFields: [b] },
        { role: 'party_a', name: '林房東', email: 'landlord@example.com', verifyMethods: ['email'], signatureFields: [a] },
      ],
    });
  });

  it('簽署區域的順序維持輸入順序，同角色的多個區域都歸該席位', () => {
    const b1 = field('f1', 'party_b', 0);
    const b2 = field('f2', 'party_b', 2);
    const result = buildSignerSequence(
      selfManaged,
      {
        'lease.self_managed.party_a': { name: 'A', email: 'a@example.com' },
        'lease.self_managed.party_b': { name: 'B', email: 'b@example.com' },
      },
      [b1, b2],
    );
    expect(result.ok && result.signers[0].signatureFields).toEqual([b1, b2]);
    expect(result.ok && result.signers[1].signatureFields).toEqual([]);
  });
});

describe('buildSignerSequence：缺少席位的簽署人', () => {
  it('回傳缺少的 rule_id，不補預設值', () => {
    const result = buildSignerSequence(
      selfManaged,
      { 'lease.self_managed.party_a': { name: '林房東', email: 'landlord@example.com' } },
      [],
    );
    expect(result).toEqual({ ok: false, missing: ['lease.self_managed.party_b'] });
  });
});

describe('buildSignerSequence：居間加包租的四位簽署人', () => {
  const plan = planOf({
    documentType: 'lease',
    caseKind: 'sublease',
    brokerMediated: true,
  });
  const assignees = {
    'lease.master_lease.party_b': { name: '乙', email: 'b@example.com' },
    'lease.master_lease.practitioner': { name: '管理員', email: 'manager@example.com' },
    'lease.master_lease.party_a': { name: '甲', email: 'a@example.com' },
    'lease.broker': { name: '經紀人', email: 'broker@example.com' },
  };

  it('兩位執業人員依 slot 分到各自的簽署區域', () => {
    const managerField = field('m1', 'practitioner', 0, 'lease.master_lease.practitioner');
    const brokerField = field('k1', 'practitioner', 0, 'lease.broker');
    const result = buildSignerSequence(plan, assignees, [brokerField, managerField]);
    if (!result.ok) throw new Error('預期成功');
    expect(result.signers.map((s) => [s.role, s.email])).toEqual([
      ['party_b', 'b@example.com'],
      ['practitioner', 'manager@example.com'],
      ['party_a', 'a@example.com'],
      ['practitioner', 'broker@example.com'],
    ]);
    expect(result.signers[1].signatureFields).toEqual([managerField]);
    expect(result.signers[3].signatureFields).toEqual([brokerField]);
  });

  it('沒有 slot 的舊簽署區域歸該角色的第一個席位', () => {
    const legacy = field('m1', 'practitioner');
    const result = buildSignerSequence(plan, assignees, [legacy]);
    if (!result.ok) throw new Error('預期成功');
    expect(result.signers[1].signatureFields).toEqual([legacy]);
    expect(result.signers[3].signatureFields).toEqual([]);
  });
});

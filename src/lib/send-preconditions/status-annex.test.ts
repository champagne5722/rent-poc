import { describe, expect, it } from 'vitest';
import { buildSignerSequence, routeSignatures, type RoutingFacts, type SeatAssignee, type SignaturePlan } from '../signature-routing';
import type { SignatureField } from '../types';
import { checkStatusAnnexSignatureFields } from './status-annex';

// 規則列的必要簽署區域頁包含現況確認附件頁（MIL-71、ADR-0018 決議 6）：
// 執業人員在附件頁沒有簽署區域時，送簽被擋下並列出原因。

const lease = (extra: { businessType?: 'self_managed' | 'managed' | 'master_lease'; lesseeIsMasterLessor?: boolean; brokerMediated?: boolean } = {}): RoutingFacts => ({
  documentType: 'lease',
  businessType: extra.businessType ?? 'master_lease',
  lesseeIsMasterLessor: extra.lesseeIsMasterLessor ?? false,
  brokerMediated: extra.brokerMediated ?? false,
});

const PAGES = { pageCount: 4, signaturePage: 1, statusAnnexPage: 3 };

const box = (id: string, signer: SignatureField['signer'], page: number, slot?: string): SignatureField => ({
  id,
  signer,
  page,
  x: 0.1,
  y: 0.8,
  w: 0.2,
  h: 0.1,
  ...(slot ? { slot } : {}),
});

const MASTER_BODY: SignatureField[] = [
  box('b', 'party_b', 1, 'lease.master_lease.party_b'),
  box('p', 'practitioner', 1, 'lease.master_lease.practitioner'),
  box('a', 'party_a', 1, 'lease.master_lease.party_a'),
];

describe('checkStatusAnnexSignatureFields', () => {
  it('執業人員在附件頁沒有簽署區域時擋下，並指出席位與原因', () => {
    const reasons = checkStatusAnnexSignatureFields(lease(), MASTER_BODY, PAGES);
    expect(reasons).toEqual([
      {
        code: 'status_annex_signature_missing',
        message: '請在現況確認附件頁為執業人員（租賃住宅管理人員）放置簽名框',
        seatRuleId: 'lease.master_lease.practitioner',
      },
    ]);
  });

  it('執業人員在附件頁有簽署區域時通過，甲乙方在附件頁不必有', () => {
    const fields = [...MASTER_BODY, box('p2', 'practitioner', 3, 'lease.master_lease.practitioner')];
    expect(checkStatusAnnexSignatureFields(lease(), fields, PAGES)).toEqual([]);
  });

  it('框放在簽名頁或別的附件頁不算', () => {
    const fields = [...MASTER_BODY, box('p2', 'practitioner', 2, 'lease.master_lease.practitioner')];
    expect(checkStatusAnnexSignatureFields(lease(), fields, PAGES)).toHaveLength(1);
  });

  it('舊資料的簽署區域沒有 slot 時，歸同角色的第一個席位', () => {
    const fields = [...MASTER_BODY, box('p2', 'practitioner', 3)];
    expect(checkStatusAnnexSignatureFields(lease(), fields, PAGES)).toEqual([]);
  });

  it('不必附現況確認附件的組合不檢查', () => {
    expect(checkStatusAnnexSignatureFields(lease({ businessType: 'self_managed' }), [], { ...PAGES, statusAnnexPage: null })).toEqual([]);
    expect(checkStatusAnnexSignatureFields(lease({ businessType: 'managed' }), [], { ...PAGES, statusAnnexPage: null })).toEqual([]);
    // 屋主與包租業者：自管、承租人是包租業者，有執業人員席位但不要求附件頁
    expect(
      checkStatusAnnexSignatureFields(lease({ businessType: 'self_managed', lesseeIsMasterLessor: true }), [], { ...PAGES, statusAnnexPage: null }),
    ).toEqual([]);
  });

  it('必附但 PDF 沒有附件頁時也擋下（不該發生，但不放行）', () => {
    const reasons = checkStatusAnnexSignatureFields(lease(), MASTER_BODY, { ...PAGES, statusAnnexPage: null });
    expect(reasons.map((r) => r.code)).toEqual(['status_annex_signature_missing']);
  });

  it('居間加包租有四位：只要求管理人員席位，經紀人席位不必在附件頁簽署', () => {
    const facts = lease({ brokerMediated: true });
    const fields = [
      ...MASTER_BODY,
      box('k', 'practitioner', 1, 'lease.broker'),
      box('p2', 'practitioner', 3, 'lease.master_lease.practitioner'),
    ];
    expect(checkStatusAnnexSignatureFields(facts, fields, PAGES)).toEqual([]);
    // 只有經紀人席位在附件頁，管理人員席位沒有：仍然擋下，而且擋的是管理人員席位
    const onlyBroker = [...MASTER_BODY, box('k', 'practitioner', 3, 'lease.broker')];
    expect(checkStatusAnnexSignatureFields(facts, onlyBroker, PAGES).map((r) => r.seatRuleId)).toEqual([
      'lease.master_lease.practitioner',
    ]);
  });

  it('同一人兼任（甲方簽署人兼專任管理人員）：附件頁的框歸合併後的那一位簽署人，仍只要求管理人員席位', () => {
    const facts = lease();
    const route = routeSignatures(facts);
    const plan = (route as { plan: SignaturePlan }).plan;
    const chen = { partyId: 'party-chen', entityId: 'org-a' };
    const person = (name: string): SeatAssignee => ({ name, email: `${name}@example.com`, identity: chen });
    const assignees: Record<string, SeatAssignee> = {
      'lease.master_lease.party_b': { name: '乙', email: 'b@example.com' },
      'lease.master_lease.practitioner': person('陳'),
      'lease.master_lease.party_a': person('陳甲'),
    };
    const fields = [...MASTER_BODY, box('p2', 'practitioner', 3, 'lease.master_lease.practitioner')];
    expect(checkStatusAnnexSignatureFields(facts, fields, PAGES)).toEqual([]);
    const built = buildSignerSequence(plan, assignees, fields);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.signers).toHaveLength(2);
    // 兩個角色的簽署區域（含附件頁的框）都歸合併後的簽署人
    expect(built.signers[1].signatureFields.map((f) => f.id).sort()).toEqual(['a', 'p', 'p2']);
    // 缺少附件頁的框時，合併不改變要求：仍擋下管理人員席位
    expect(checkStatusAnnexSignatureFields(facts, MASTER_BODY, PAGES).map((r) => r.seatRuleId)).toEqual([
      'lease.master_lease.practitioner',
    ]);
  });
});

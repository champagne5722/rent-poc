// 移交 seam 的記憶體 adapter。測試與畫面冒煙用，資料在程序重啟後消失。
import type {
  HandoverRecord,
  HandoverStore,
  MandateCase,
  PaymentAccount,
  ReceiverCandidate,
  UnitHandoverSource,
} from './store';

export interface HandoverSeed {
  mandateCases: MandateCase[];
  unitSources: UnitHandoverSource[];
  receiverCandidates: { ownerPartyId: string; candidates: ReceiverCandidate[] }[];
  paymentAccounts: { ownerPartyId: string; accounts: PaymentAccount[] }[];
  orgPaymentAccounts: { orgId: string; accounts: PaymentAccount[] }[];
  /** 已簽 PDF 的位元組，鍵是文件 ID。 */
  signedPdfs: Record<string, Uint8Array>;
  handovers: HandoverRecord[];
}

export function createMemoryHandoverStore(seed: HandoverSeed): HandoverStore {
  // 回傳複本，避免呼叫端改到 store 內的資料
  const copy = <T>(value: T): T => structuredClone(value);
  const handovers = new Map(seed.handovers.map((h) => [h.id, copy(h)]));
  let sequence = handovers.size;

  return {
    async listHandoversByOwner(ownerPartyId) {
      return [...handovers.values()].filter((h) => h.ownerPartyId === ownerPartyId).map(copy);
    },
    async getHandover(id) {
      const found = handovers.get(id);
      return found ? copy(found) : null;
    },
    async saveHandover(record) {
      handovers.set(record.id, copy(record));
    },
    async listMandateCasesByOwner(ownerPartyId) {
      return seed.mandateCases.filter((m) => m.ownerPartyId === ownerPartyId).map(copy);
    },
    async getUnitSource(rentalUnitId) {
      const found = seed.unitSources.find((u) => u.rentalUnitId === rentalUnitId);
      return found ? copy(found) : null;
    },
    async listReceiverCandidates(ownerPartyId) {
      return copy(seed.receiverCandidates.find((r) => r.ownerPartyId === ownerPartyId)?.candidates ?? []);
    },
    async listOwnerPaymentAccounts(ownerPartyId) {
      return copy(seed.paymentAccounts.find((p) => p.ownerPartyId === ownerPartyId)?.accounts ?? []);
    },
    async listHandoversByOrg(orgId) {
      return [...handovers.values()]
        .filter((h) => h.from.orgId === orgId || (h.target?.kind === 'mandatary' && h.target.orgId === orgId))
        .map(copy);
    },
    async listOrgPaymentAccounts(orgId) {
      return copy(seed.orgPaymentAccounts.find((p) => p.orgId === orgId)?.accounts ?? []);
    },
    async getSignedPdf(docId) {
      const bytes = seed.signedPdfs[docId];
      return bytes ? bytes.slice() : null;
    },
    newHandoverId() {
      sequence += 1;
      return `ho-${String(sequence).padStart(4, '0')}`;
    },
  };
}

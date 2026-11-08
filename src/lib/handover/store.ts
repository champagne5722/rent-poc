// 移交的資料存取 seam（MIL-97）。這張票只有記憶體 adapter（memory-store.ts）。
// 接線票（MIL-105、MIL-107）換成 control.handovers 與兩側組織的表，呼叫端（service.ts）不動。
import type { PracticeEntityStatus } from './preconditions';
import type { HandoverManualFields, HandoverSnapshot, HandoverSnapshotFacts } from './snapshot';
import type { HandoverEventType, HandoverState } from './transitions';

/** 執業主體的組織。名稱與法定稱謂跨組織可讀（GLOSSARY「執業主體」）。 */
export interface PracticeEntityRef {
  orgId: string;
  name: string;
  statutoryTitle: string;
  status: PracticeEntityStatus;
}

/** 委託標的清單上的一個租賃單位。 */
export interface MandateUnit {
  rentalUnitId: string;
  address: string;
  unitLabel: string;
  /** 沒有租賃案件的空置單位是 null。 */
  leaseCaseId: string | null;
}

/** 屋主為 `mandator` 的委託管理案件。 */
export interface MandateCase {
  id: string;
  ownerPartyId: string;
  mandatary: PracticeEntityRef;
  status: 'active' | 'terminated';
  units: MandateUnit[];
}

/** 產生移交包草稿要讀的事實，來源是 B、C、D、E 線。 */
export interface UnitHandoverSource {
  rentalUnitId: string;
  hasActiveSigningTask: boolean;
  /** 目前押金與預收租金所在收款帳戶的持有人名稱。 */
  currentAccountHolder: string | null;
  snapshot: Omit<HandoverSnapshotFacts, 'handoverId' | 'rentalUnitId' | 'manual'>;
}

/** 屋主可以選的新受託人，以及它對各租賃單位的委託。 */
export interface ReceiverCandidate {
  entity: PracticeEntityRef;
  /** 有效委託管理案件涵蓋的租賃單位 ID。 */
  mandatedUnitIds: string[];
  /** 只有上傳紙本契約書的租賃單位 ID。 */
  paperContractUnitIds: string[];
}

/** 收款帳戶只記遮罩識別（GLOSSARY「收款帳戶」）。 */
export interface PaymentAccount {
  id: string;
  label: string;
  holderName: string;
}

export type HandoverTarget =
  | { kind: 'mandatary'; orgId: string; name: string }
  | {
      kind: 'self_managed';
      paymentAccountId: string;
      /** 收款帳戶持有人變更的說明（P0-22 規則 4）。沒有變更時是 null。 */
      evidenceNote: string | null;
    };

/** 收款帳戶持有人變更時附的證據，檔案或說明擇一（P0-22 規則 4）。 */
export interface HolderChangeEvidence {
  note: string | null;
  /** 記憶體 adapter 只記檔名、大小與雜湊。存檔的路徑由 MIL-107 接上。 */
  file: { name: string; size: number; sha256: string } | null;
}

/** 接收方確認接手時選的收款帳戶（ADR-0024 決議 9）。 */
export interface ReceiverAccountChoice {
  paymentAccountId: string;
  label: string;
  holderName: string;
  /** 持有人沒有變更時是 null。 */
  evidence: HolderChangeEvidence | null;
}

export interface HandoverEventRecord {
  type: HandoverEventType | 'handover_draft_created' | 'handover_manual_updated';
  at: string;
}

export interface HandoverRecord {
  id: string;
  ownerPartyId: string;
  mandateCaseId: string;
  rentalUnitId: string;
  address: string;
  unitLabel: string;
  leaseCaseId: string | null;
  from: { orgId: string; name: string };
  target: HandoverTarget | null;
  state: HandoverState;
  /** YYYY-MM-DD。代管接手時由接收方指定，改自管時由屋主指定。 */
  effectiveDate: string | null;
  /** 屋主勾選知悉的缺項鍵（`類別.項目`）。 */
  acknowledgedMissing: string[];
  manual: HandoverManualFields;
  /** 交出側生效時凍結的快照與雜湊。凍結前是 null，畫面從事實即時產生草稿。 */
  frozenSnapshot: HandoverSnapshot | null;
  snapshotHash: string | null;
  /** 代管接手時接收方選的收款帳戶（MIL-98）。改自管時帳戶在 target，接手前沒有值。 */
  receiverAccount?: ReceiverAccountChoice;
  createdAt: string;
  events: HandoverEventRecord[];
}

export interface HandoverStore {
  listHandoversByOwner(ownerPartyId: string): Promise<HandoverRecord[]>;
  getHandover(id: string): Promise<HandoverRecord | null>;
  saveHandover(record: HandoverRecord): Promise<void>;
  listMandateCasesByOwner(ownerPartyId: string): Promise<MandateCase[]>;
  getUnitSource(rentalUnitId: string): Promise<UnitHandoverSource | null>;
  listReceiverCandidates(ownerPartyId: string): Promise<ReceiverCandidate[]>;
  listOwnerPaymentAccounts(ownerPartyId: string): Promise<PaymentAccount[]>;
  /** 交出方或接收方是這個組織的移交（MIL-98，後台）。 */
  listHandoversByOrg(orgId: string): Promise<HandoverRecord[]>;
  /** 執業主體組織自己的收款帳戶。 */
  listOrgPaymentAccounts(orgId: string): Promise<PaymentAccount[]>;
  /** 已簽 PDF 的位元組，移交包匯出用。找不到時是 null。 */
  getSignedPdf(docId: string): Promise<Uint8Array | null>;
  newHandoverId(): string;
}

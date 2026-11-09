// 簽章紀錄的型別（MIL-70，ADR-0018 決議 12）。純型別，client 與 server 都能引用。

import type { LicenseKind } from '../labels';
import type { SignerRole } from '../types';
import type { CredentialSnapshot, SignatureSnapshot } from './snapshot';

/**
 * 一個執業人員席位要寫入的簽章紀錄。`signerIndex` 是該席位的簽署人在送給簽署模組的簽署序列中的位置。
 * 送簽前算好的部分是 `ContractSendRecord`，兼任角色由訂閱者從簽署序列的 `Signer.concurrentRoles` 補上
 * （合併後自動帶入，MIL-76）。
 */
export interface SignatureRecordInput {
  signerIndex: number;
  /** 席位的 rule_id。同一份合約內唯一。 */
  ruleId: string;
  statuteRef: string;
  ruleVersion: number;
  practitionerId: string;
  employmentId: string;
  entityId: string;
  /** 判定事實的業別層用哪一種業別。簽署當下重新判定時要用同一種。 */
  licenseKind: LicenseKind;
  /** 兼任的其他角色。沒有兼任時是空陣列。 */
  concurrentRoles: SignerRole[];
  snapshotAtSend: CredentialSnapshot;
}

/**
 * 送簽時交給簽署模組、原樣傳給訂閱者 `onSent` 的資料（MIL-70）。
 * 合約訂閱者在送簽交易內用它寫簽章紀錄，所以簽署任務建立失敗時不留紀錄。
 */
export interface ContractSendContext {
  kind: 'contract_send';
  records: ContractSendRecord[];
}

/** 送簽前算好的一列。兼任角色由訂閱者從簽署序列補上。 */
export type ContractSendRecord = Omit<SignatureRecordInput, 'concurrentRoles'>;

export function isContractSendContext(value: unknown): value is ContractSendContext {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'contract_send';
}

/** 一筆簽章紀錄。只為執業人員寫一列，`signerId` 參照簽署人列。 */
export interface SignatureRecord {
  id: number;
  contractId: number;
  signerId: number;
  ruleId: string;
  statuteRef: string;
  ruleVersion: number;
  practitionerId: string;
  employmentId: string;
  entityId: string;
  licenseKind: LicenseKind;
  concurrentRoles: SignerRole[];
  snapshotAtSend: CredentialSnapshot;
  /** 簽署事件時補上。還沒簽署時是 null。 */
  snapshotAtSign: SignatureSnapshot | null;
  createdAt: string;
}

/** 等著補 snapshot_at_sign 的紀錄。`signerEmail` 用來對應簽署事件的簽署人。 */
export interface PendingSignRecord {
  ruleId: string;
  practitionerId: string;
  licenseKind: LicenseKind;
  signerEmail: string;
}

/** 詳情頁用：簽章紀錄加上所參照簽署人列的狀態，以及執業主體名稱（查不到時是 null）。 */
export interface SignatureRecordDetail extends SignatureRecord {
  signer: {
    name: string;
    role: SignerRole;
    status: 'pending' | 'signed' | 'declined';
    /** 簽署人表存的本地時間字串（YYYY-MM-DD HH:mm:ss）。 */
    signedAt: string | null;
  };
  entityName: string | null;
}

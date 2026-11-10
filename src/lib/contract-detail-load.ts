import { authorize, bindAccessContext, checkAccess, Forbidden } from './authorize';
import { getContract, getContractRelations, listContractEvents } from './contracts';
import { requestContext } from './current-request-context';
import { withTx } from './pg/database';
import { isUlid } from './pg/ulid';
import { getPracticeRegistry } from './practice-registry';
import { getAssignments } from './practitioner-assignment/repository';
import { loadPrintedPractitioners } from './practitioner-assignment/service';
import type { PrintedPractitioner } from './practitioner-assignment/seats';
import { getProperty } from './properties';
import { toDbContext } from './request-context';
import { loadContractRoutingFacts } from './signature-routing/repository';
import { signatureRecordDetails } from './signature-records/detail';
import { listSignatureRecords, listSignatureRecordSigners } from './signature-records/repository';
import type { SignatureRecordDetail } from './signature-records/types';
import { listSigningLapses } from './signing-lapse/repository';
import type { SigningLapseDetail } from './signing-lapse/types';
import { contractSubject, signing } from './signing-module';
import type { SigningProgress } from './signing-module/sign-task-store';
import type { Contract, ContractEvent, ContractFile, ContractRelations } from './types';

// 合約詳情的資料載入（MIL-175）。詳情頁在 server component 呼叫它，client component 只管畫面與操作。
// 讀的資料與原本詳情頁打的 7 支 GET API 相同：合約與衍生鏈、簽署進度、歷程、文件、已指派的執業人員、
// 簽章紀錄、簽署中失效紀錄。簽署模式（mock）與物件顯示編碼也在這裡一併帶出。

export interface ContractDetailData {
  contract: Contract;
  relations: ContractRelations;
  signingProgress: SigningProgress | null;
  events: ContractEvent[];
  files: ContractFile[];
  /** 已指派的執業人員，以席位 rule_id 為鍵。 */
  practitioners: Record<string, PrintedPractitioner>;
  signatureRecords: SignatureRecordDetail[];
  signingLapses: SigningLapseDetail[];
  /** 物件的顯示編碼。沒有物件讀取權限或讀不到物件時是 undefined，畫面不顯示這一列。 */
  displayCode: string | null | undefined;
  /** 簽署模式是 mock。 */
  mock: boolean;
}

export type ContractDetailLoad =
  | ({ kind: 'ok' } & ContractDetailData)
  // 格式錯誤的 ID、別的組織的 ID、不存在的 ID、沒有查看權限，對外同一個畫面（P0-02 AC1）
  | { kind: 'not_found' }
  // 不是組織身分
  | { kind: 'forbidden' };

/**
 * 載入一份合約的詳情。沒登入時丟 Unauthenticated，由頁面導向登入。
 * 只給 server component 用；route handler 走 readInOrgTx，才能把拒絕轉成 401、403 的回應。
 */
export async function loadContractDetail(id: string): Promise<ContractDetailLoad> {
  const rc = await requestContext();
  if (rc.kind !== 'org') return { kind: 'forbidden' };
  if (!isUlid(id)) return { kind: 'not_found' };

  let read;
  try {
    read = await withTx(toDbContext(rc), async (tx) => {
      bindAccessContext(tx, rc);
      await authorize(tx, 'contract.read', { type: 'contract', id });
      const contract = await getContract(tx, id);
      if (!contract) return null;
      const records = await listSignatureRecords(tx, id);
      // 顯示編碼是輔助資訊：沒有物件讀取權限時，詳情照常顯示
      const canReadProperty = contract.property_id
        ? (await checkAccess(tx, 'property.read', { type: 'property', id: contract.property_id })).allowed
        : false;
      return {
        contract,
        relations: await getContractRelations(tx, contract),
        events: await listContractEvents(tx, id),
        routing: await loadContractRoutingFacts(tx, id),
        assignments: await getAssignments(tx, id),
        records,
        signers: records.length > 0 ? await listSignatureRecordSigners(tx, id) : new Map(),
        lapses: await listSigningLapses(tx, id),
        displayCode:
          canReadProperty && contract.property_id
            ? ((await getProperty(tx, contract.property_id))?.unit?.display_code ?? null)
            : undefined,
      };
    });
  } catch (error) {
    if (error instanceof Forbidden) return { kind: 'not_found' };
    throw error;
  }
  if (!read) return { kind: 'not_found' };

  // 簽署任務、文件與執業人員登錄在交易外讀（簽署任務在簽署模組，登錄是外部來源，ADR-0012 決議 10）
  const subject = contractSubject(id);
  const resolution = getPracticeRegistry();
  const [signingProgress, files, practitioners, signatureRecords, mode] = await Promise.all([
    signing.getProgress(subject),
    signing.listFiles(subject),
    read.routing.ok
      ? loadPrintedPractitioners(
          read.routing.facts,
          read.assignments.map(({ slot, entityId, practitionerId, partySignerId }) => ({ slot, entityId, practitionerId, partySignerId })),
          resolution
        )
      : Promise.resolve({}),
    signatureRecordDetails(read.records, read.signers),
    signing.mode(),
  ]);

  return {
    kind: 'ok',
    contract: read.contract,
    relations: read.relations,
    signingProgress,
    events: read.events,
    // 物件 key 是儲存層的位置，不對外；SHA-256 對外給（MIL-87）
    // 回應形狀與 GET /api/contracts/[id]/files 相同。型別沿用 ContractFile（它的 id 還是舊的數字型別，實際是字串）
    files: files.map(({ object_key, ...rest }) => {
      void object_key;
      return { ...rest, contract_id: id };
    }) as unknown as ContractFile[],
    practitioners,
    signatureRecords,
    signingLapses: read.lapses,
    displayCode: read.displayCode,
    mock: mode === 'mock',
  };
}

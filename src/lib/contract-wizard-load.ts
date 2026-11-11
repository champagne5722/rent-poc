import { authorize, bindAccessContext, Forbidden } from './authorize';
import { getContract } from './contracts';
import { requestContext } from './current-request-context';
import { getMandateItems } from './mandate-schedule/repository';
import type { MandateItem } from './mandate-schedule';
import { withTx } from './pg/database';
import { isUlid } from './pg/ulid';
import { loadLeasingAuthorityFacts } from './ownership/send-facts';
import { loadBrokerChoice } from './practitioner-assignment/broker-guard';
import { buildPractitionerPayload, type PractitionerPayload } from './practitioner-assignment/payload';
import { getAssignments } from './practitioner-assignment/repository';
import { toDbContext } from './request-context';
import { loadContractRoutingFacts } from './signature-routing/repository';
import type { Contract } from './types';

// 建約精靈（草稿續編）的資料載入（MIL-176）。精靈頁在 server component 呼叫它，client component 只管步驟與互動。
// 讀的資料與原本精靈載入時打的三支 GET API 相同：合約、委託標的清單（只有委託管理合約）、指派資料。
// 存檔後重讀指派資料仍走 GET /api/contracts/[id]/practitioners，那是操作後的更新，不是首屏載入。

export interface ContractWizardData {
  contract: Contract;
  /** 委託標的清單。沒有清單的合約類型是 null。 */
  mandateItems: MandateItem[] | null;
  /** 指派資料。分流條件無效時是 null，由畫面退回第①步改條件。 */
  practitioners: PractitionerPayload | null;
}

export type ContractWizardLoad =
  | ({ kind: 'ok' } & ContractWizardData)
  // 格式錯誤的 ID、別的組織的 ID、不存在的 ID、沒有查看權限，對外同一個畫面（P0-02 AC1）
  | { kind: 'not_found' }
  // 不是組織身分
  | { kind: 'forbidden' };

/**
 * 載入精靈要用的資料。沒登入時丟 Unauthenticated，由頁面導向登入。
 * 只給 server component 用；route handler 走 readInOrgTx，才能把拒絕轉成 401、403 的回應。
 */
export async function loadContractWizard(id: string): Promise<ContractWizardLoad> {
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
      return {
        contract,
        mandateItems: contract.contract_type === 'management' ? await getMandateItems(tx, id) : null,
        brokerChoice: await loadBrokerChoice(tx, rc.orgKind),
        routing: await loadContractRoutingFacts(tx, id),
        stored: await getAssignments(tx, id),
        leasingAuthority: await loadLeasingAuthorityFacts(tx, contract),
      };
    });
  } catch (error) {
    if (error instanceof Forbidden) return { kind: 'not_found' };
    throw error;
  }
  if (!read) return { kind: 'not_found' };

  // 登錄查詢在交易外（ADR-0012 決議 10）
  const practitioners = read.routing.ok
    ? await buildPractitionerPayload({
        contract: read.contract,
        routing: read.routing,
        assignments: read.stored.map(({ slot, entityId, practitionerId, partySignerId }) => ({ slot, entityId, practitionerId, partySignerId })),
        leasingAuthority: read.leasingAuthority,
        brokerChoice: read.brokerChoice,
      })
    : null;
  return { kind: 'ok', contract: read.contract, mandateItems: read.mandateItems, practitioners };
}

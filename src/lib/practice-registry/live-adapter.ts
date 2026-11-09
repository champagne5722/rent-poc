// practiceRegistry 的真實 adapter（MIL-113，ADR-0023 決議 8、ADR-0021 決議 3）。
// 只經 registry schema 的定義者函式（db/migrations/0070）讀全域登錄，app_rw 對 registry 的表沒有直接權限。
//
// 交易：seam 的方法沒有交易參數，所以 adapter 由「執行器」建立。每個方法呼叫執行器一次，在執行器給的 tx 內
// 查一次，查完就提交。route 與訂閱者的登錄查詢本來就在交易外（ADR-0012 決議 10），所以呼叫端不必改。
// 已經持有 tx 的呼叫端（例如測試）用 `txRunner(tx)`。
//
// 可簽章的判定不在這裡：adapter 只提供事實（三層狀態、valid_until、任職期間、三層最新核對紀錄 ID），
// 由 D 線的 `credentialStatusAt()` 判定。`listPractitioners` 用它排除「人員本身」查詢時點不可簽章的人
// （證書或任職未驗證、已期滿、任職已結束）。業別層不在這裡排除：業別未驗證是執業主體的問題，要留在候選上讓呼叫端說明原因。

import { credentialStatusAt, type CredentialFacts } from '../credential-status';
import type { CertificateKind, LicenseKind } from '../labels';
import type { OrgTx } from '../pg/with-tx';
import { formatCertificateNumber, type CertificateNumber } from '../practitioners/rules';
import type { CredentialState } from '../registry-rules';
import type {
  PartySignerCandidate,
  PracticeEntity,
  PracticeRegistry,
  PractitionerCandidate,
  PractitionerQuery,
} from './types';

/** 在某個組織脈絡內開一個交易跑 fn。每次呼叫是一個獨立的交易。 */
export type RegistryRunner = <R>(fn: (tx: OrgTx) => Promise<R>) => Promise<R>;

/** 已經持有 tx 時的執行器：直接用它，不另開交易。 */
export function txRunner(tx: OrgTx): RegistryRunner {
  return (fn) => fn(tx);
}

export interface LiveRegistryOptions {
  run: RegistryRunner;
  /** 判定時點。預設系統時間；測試傳固定時間。 */
  now?: () => Date;
}

interface RawLicense {
  kind: LicenseKind;
  state: CredentialState;
  last_check_id: string | null;
}

interface RawPractitioner {
  employment_id: string;
  party_id: string;
  name: string;
  account_email: string;
  certificate_kind: CertificateKind;
  certificate_no: CertificateNumber | null;
  practitioner_state: CredentialState;
  valid_until: string;
  practitioner_last_check_id: string | null;
  employment_state: CredentialState;
  employment_started_on: string;
  employment_ended_on: string | null;
  employment_last_check_id: string | null;
}

interface RawView {
  entity_id?: string;
  licenses: RawLicense[];
  practitioners: RawPractitioner[];
}

export function createLivePracticeRegistry({ run, now = () => new Date() }: LiveRegistryOptions): PracticeRegistry {
  const viewOf = (entityId: string | null, employmentId: string | null) =>
    run(async (tx) => {
      const { rows } = await tx.query<{ view: RawView }>('SELECT registry.signing_view($1, $2) AS view', [entityId, employmentId]);
      return rows[0].view;
    });

  function toCandidate(raw: RawPractitioner, view: RawView, licenseKind: LicenseKind): PractitionerCandidate {
    const license = view.licenses.find((l) => l.kind === licenseKind);
    const credential: CredentialFacts = {
      license: { state: license?.state ?? null, validUntil: null, latestCheckId: license?.last_check_id ?? null },
      practitioner: { state: raw.practitioner_state, validUntil: raw.valid_until, latestCheckId: raw.practitioner_last_check_id },
      employment: {
        state: raw.employment_state,
        startsOn: raw.employment_started_on,
        endsOn: raw.employment_ended_on,
        latestCheckId: raw.employment_last_check_id,
      },
    };
    return {
      // 候選的 ID 就是任職 ID：getPractitioner 沒有執業主體參數，任職 ID 才對得到唯一的執業主體與證書
      id: raw.employment_id,
      employmentId: raw.employment_id,
      partyId: raw.party_id,
      name: raw.name,
      accountEmail: raw.account_email,
      certificateKind: raw.certificate_kind,
      // 專任：管理人員的已驗證任職受排除約束保護（同一證號最多一筆）。其他證書種類沒有專任要求
      fullTime: raw.certificate_kind === 'rental_housing_manager' && raw.employment_state === 'verified',
      // 登錄沒有負責人資料
      isResponsiblePerson: false,
      entityId: view.entity_id!,
      certificateNo: raw.certificate_no ? formatCertificateNumber(raw.certificate_no) : null,
      credential,
    };
  }

  return {
    kind: 'live',

    async listEntities(query) {
      const rows = await run(async (tx) => {
        const result = await tx.query<{ entity_id: string; name: string; license_kinds: LicenseKind[] }>(
          'SELECT * FROM registry.list_practice_entities($1)',
          [query?.licenseKind ?? null],
        );
        return result.rows;
      });
      return rows.map((r): PracticeEntity => ({ id: r.entity_id, name: r.name, licenseKinds: r.license_kinds }));
    },

    async getEntity(entityId) {
      const rows = await run(async (tx) => {
        const result = await tx.query<{ entity_id: string; name: string; kind: LicenseKind | null }>(
          'SELECT entity_id, name, kind FROM registry.lookup_practice_entities($1::text[])',
          [[entityId]],
        );
        return result.rows;
      });
      if (rows.length === 0) return null;
      return {
        id: rows[0].entity_id,
        name: rows[0].name,
        licenseKinds: rows.flatMap((r) => (r.kind ? [r.kind] : [])),
      };
    },

    async listPartySigners(entityId) {
      return partySigners(run, entityId, null);
    },

    async getPartySigner(partySignerId) {
      return (await partySigners(run, null, partySignerId))[0] ?? null;
    },

    async listPractitioners(entityId, query: PractitionerQuery) {
      const view = await viewOf(entityId, null);
      const at = now().toISOString();
      return view.practitioners
        .filter((p) => query.certificateKinds.includes(p.certificate_kind))
        .map((p) => toCandidate(p, view, query.licenseKind))
        .filter((c) => !query.fullTime || c.fullTime)
        .filter((c) => personallySignable(c.credential, at));
    },

    async getPractitioner(practitionerId, query) {
      const view = await viewOf(null, practitionerId);
      const raw = view.practitioners[0];
      return raw ? toCandidate(raw, view, query.licenseKind) : null;
    },
  };
}

async function partySigners(run: RegistryRunner, entityId: string | null, membershipId: string | null): Promise<PartySignerCandidate[]> {
  const rows = await run(async (tx) => {
    const result = await tx.query<{ membership_id: string; party_id: string; entity_id: string; name: string; email: string }>(
      'SELECT * FROM registry.party_signer_candidates($1, $2)',
      [entityId, membershipId],
    );
    return result.rows;
  });
  return rows.map((r) => ({ id: r.membership_id, partyId: r.party_id, entityId: r.entity_id, name: r.name, email: r.email }));
}

/** 業別層以外的兩層在查詢時點可簽章。業別未驗證是執業主體的問題，由呼叫端依判定事實說明。 */
function personallySignable(credential: CredentialFacts, at: string): boolean {
  const personal = credentialStatusAt({ ...credential, license: { state: 'verified', validUntil: null, latestCheckId: null } }, at);
  return personal.signable;
}

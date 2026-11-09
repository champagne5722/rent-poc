// practiceRegistry 的 seed 假資料 adapter（ADR-0021 決議 3）。
// 公司名、人名與 email 都是虛構的，email 用 example.com。只用於 mock 與 sandbox，正式環境由 index.ts 擋下。
//
// 效期用「今天」推算，這樣換證窗口的案例不會因為日期流逝而失效。測試傳入固定的 today。
//
// 資料涵蓋送簽前檢查的各種結果：
// - 北辰：陳怡君（可簽章）、林志豪（換證窗口內）、吳家豪（專任旗標為否）、張明華（負責人，沒有證書）、
//   周大衛（證書已失效）、許文傑（任職已結束）。兼營代管與包租。
// - 星河：登記了代管業別，但業別尚未驗證（委託管理合約的受託人被擋下，MIL-74）。邢雅芳是它的專任管理人員。
// - 北辰的當事人簽署人王建國、李淑芬，以及陳怡君本人（與執業人員同一人，MIL-76 的合併案例）。
// - 雲頂不動產經紀：趙經紀（經紀人）、孫小美（經紀營業員，不得簽章）。

import { addMonths, type CredentialState } from '../registry-rules';
import { credentialStatusAt, type CredentialFacts } from '../credential-status';
import type { CertificateKind, LicenseKind } from '../labels';
import type {
  PartySignerCandidate,
  PracticeEntity,
  PracticeRegistry,
  PractitionerCandidate,
  PractitionerQuery,
} from './types';

export const SEED_ENTITIES: readonly PracticeEntity[] = [
  { id: 'org-pe-beichen', name: '北辰租賃住宅管理股份有限公司', licenseKinds: ['management', 'master_lease'] },
  { id: 'org-pe-suilin', name: '穗林物業管理顧問有限公司', licenseKinds: ['master_lease'] },
  { id: 'org-pe-yaoshi', name: '曜石不動產管理有限公司', licenseKinds: ['management'] },
  { id: 'org-pe-qinghe', name: '青禾租賃住宅管理有限公司', licenseKinds: ['management'] },
  { id: 'org-pe-yunding', name: '雲頂不動產經紀有限公司', licenseKinds: ['brokerage'] },
  { id: 'org-pe-xinghe', name: '星河租賃住宅管理有限公司', licenseKinds: ['management'] },
];

/** 登記了、但業別層還是 pending 的組合，鍵是「執業主體:業別」。 */
const UNVERIFIED_LICENSES: ReadonlySet<string> = new Set(['org-pe-xinghe:management']);

export const SEED_PARTY_SIGNERS: readonly PartySignerCandidate[] = [
  { id: 'ps-wang', partyId: 'party-ps-wang', entityId: 'org-pe-beichen', name: '王建國', email: 'wang.jianguo@beichen.example.com' },
  { id: 'ps-li', partyId: 'party-ps-li', entityId: 'org-pe-beichen', name: '李淑芬', email: 'li.shufen@beichen.example.com' },
  // 與執業人員 pr-chen 是同一人（同 email、同 partyId）。送簽時合併成一位簽署人（MIL-76）。
  { id: 'ps-chen', partyId: 'party-chen', entityId: 'org-pe-beichen', name: '陳怡君', email: 'chen.yijun@beichen.example.com' },
  { id: 'ps-su', partyId: 'party-ps-su', entityId: 'org-pe-suilin', name: '蘇志明', email: 'su.zhiming@suilin.example.com' },
  { id: 'ps-yao', partyId: 'party-ps-yao', entityId: 'org-pe-yaoshi', name: '姚國棟', email: 'yao.guodong@yaoshi.example.com' },
  { id: 'ps-qing', partyId: 'party-ps-qing', entityId: 'org-pe-qinghe', name: '秦玉蘭', email: 'qin.yulan@qinghe.example.com' },
  { id: 'ps-yun', partyId: 'party-ps-yun', entityId: 'org-pe-yunding', name: '雲海濤', email: 'yun.haitao@yunding.example.com' },
  { id: 'ps-xing', partyId: 'party-ps-xing', entityId: 'org-pe-xinghe', name: '邢志遠', email: 'xing.zhiyuan@xinghe.example.com' },
];

interface SeedPractitioner {
  id: string;
  name: string;
  accountEmail: string;
  certificateKind: CertificateKind | null;
  fullTime: boolean;
  isResponsiblePerson?: boolean;
  entityId: string;
  /** 證書效期距今幾個月 */
  certMonths: number | null;
  certState?: CredentialState | null;
  employmentState?: CredentialState | null;
  /** 任職結束距今幾個月（負數代表已結束） */
  employmentEndMonths?: number;
}

const SEED_PRACTITIONERS: readonly SeedPractitioner[] = [
  {
    id: 'pr-chen',
    name: '陳怡君',
    accountEmail: 'chen.yijun@beichen.example.com',
    certificateKind: 'rental_housing_manager',
    fullTime: true,
    entityId: 'org-pe-beichen',
    certMonths: 30,
  },
  {
    // 證書 3 個月後期滿：在換證窗口內，仍可簽章
    id: 'pr-lin',
    name: '林志豪',
    accountEmail: 'lin.zhihao@beichen.example.com',
    certificateKind: 'rental_housing_manager',
    fullTime: true,
    entityId: 'org-pe-beichen',
    certMonths: 3,
  },
  {
    id: 'pr-wu',
    name: '吳家豪',
    accountEmail: 'wu.jiahao@beichen.example.com',
    certificateKind: 'rental_housing_manager',
    fullTime: false,
    entityId: 'org-pe-beichen',
    certMonths: 30,
  },
  {
    id: 'pr-zhang',
    name: '張明華',
    accountEmail: 'zhang.minghua@beichen.example.com',
    certificateKind: null,
    fullTime: false,
    isResponsiblePerson: true,
    entityId: 'org-pe-beichen',
    certMonths: null,
    certState: null,
  },
  {
    id: 'pr-zhou',
    name: '周大衛',
    accountEmail: 'zhou.dawei@beichen.example.com',
    certificateKind: 'rental_housing_manager',
    fullTime: true,
    entityId: 'org-pe-beichen',
    certMonths: 12,
    certState: 'lapsed',
  },
  {
    id: 'pr-xu',
    name: '許文傑',
    accountEmail: 'xu.wenjie@beichen.example.com',
    certificateKind: 'rental_housing_manager',
    fullTime: true,
    entityId: 'org-pe-beichen',
    certMonths: 30,
    employmentEndMonths: -2,
  },
  {
    id: 'pr-su',
    name: '蘇雅婷',
    accountEmail: 'su.yating@suilin.example.com',
    certificateKind: 'rental_housing_manager',
    fullTime: true,
    entityId: 'org-pe-suilin',
    certMonths: 24,
  },
  {
    id: 'pr-yao',
    name: '姚佩珊',
    accountEmail: 'yao.peishan@yaoshi.example.com',
    certificateKind: 'rental_housing_manager',
    fullTime: true,
    entityId: 'org-pe-yaoshi',
    certMonths: 24,
  },
  {
    id: 'pr-qing',
    name: '秦宏達',
    accountEmail: 'qin.hongda@qinghe.example.com',
    certificateKind: 'rental_housing_manager',
    fullTime: true,
    entityId: 'org-pe-qinghe',
    certMonths: 24,
  },
  {
    id: 'pr-xing',
    name: '邢雅芳',
    accountEmail: 'xing.yafang@xinghe.example.com',
    certificateKind: 'rental_housing_manager',
    fullTime: true,
    entityId: 'org-pe-xinghe',
    certMonths: 24,
  },
  {
    id: 'pr-zhao',
    name: '趙經紀',
    accountEmail: 'zhao.jingji@yunding.example.com',
    certificateKind: 'real_estate_broker',
    fullTime: false,
    entityId: 'org-pe-yunding',
    certMonths: 24,
  },
  {
    id: 'pr-sun',
    name: '孫小美',
    accountEmail: 'sun.xiaomei@yunding.example.com',
    certificateKind: 'real_estate_sales_agent',
    fullTime: false,
    entityId: 'org-pe-yunding',
    certMonths: 24,
  },
];

// 假證號：種類代碼加固定序號，只用於 seed 資料
const CERT_PREFIX: Record<CertificateKind, string> = {
  rental_housing_manager: 'RHM',
  real_estate_broker: 'BRK',
  real_estate_sales_agent: 'SLS',
};

/**
 * 自然人的 party ID。seed 裡只有陳怡君同時是當事人簽署人與執業人員，兩邊用同一個 partyId。
 * 同姓的人（例如蘇志明與蘇雅婷）是不同人，partyId 不同。
 */
function seedPartyId(seed: SeedPractitioner): string {
  return seed.id === 'pr-chen' ? 'party-chen' : `party-${seed.id}`;
}

function seedCertificateNo(seed: SeedPractitioner): string | null {
  if (!seed.certificateKind) return null;
  const index = SEED_PRACTITIONERS.findIndex((p) => p.id === seed.id);
  return `${CERT_PREFIX[seed.certificateKind]}-${String(100200 + index * 37).padStart(7, '0')}`;
}

function todayInTaiwan(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export interface SeedRegistryOptions {
  /** YYYY-MM-DD，台灣日期。效期從這一天推算。 */
  today?: () => string;
}

export function createSeedPracticeRegistry({ today = todayInTaiwan }: SeedRegistryOptions = {}): PracticeRegistry {
  function toCandidate(seed: SeedPractitioner, licenseKind: LicenseKind): PractitionerCandidate {
    const t = today();
    const entity = SEED_ENTITIES.find((e) => e.id === seed.entityId)!;
    const credential: CredentialFacts = {
      license: {
        state: !entity.licenseKinds.includes(licenseKind)
          ? null
          : UNVERIFIED_LICENSES.has(`${entity.id}:${licenseKind}`)
            ? 'pending'
            : 'verified',
        validUntil: null,
        latestCheckId: `chk-${seed.entityId}-${licenseKind}`,
      },
      practitioner: {
        state: seed.certState === undefined ? 'verified' : seed.certState,
        validUntil: seed.certMonths === null ? null : addMonths(t, seed.certMonths),
        latestCheckId: seed.certificateKind ? `chk-cert-${seed.id}` : null,
      },
      employment: {
        state: seed.employmentState === undefined ? 'verified' : seed.employmentState,
        startsOn: addMonths(t, -24),
        endsOn: seed.employmentEndMonths === undefined ? null : addMonths(t, seed.employmentEndMonths),
        latestCheckId: `chk-emp-${seed.id}`,
      },
    };
    return {
      id: seed.id,
      partyId: seedPartyId(seed),
      name: seed.name,
      accountEmail: seed.accountEmail,
      certificateKind: seed.certificateKind,
      fullTime: seed.fullTime,
      isResponsiblePerson: seed.isResponsiblePerson ?? false,
      entityId: seed.entityId,
      employmentId: `emp-${seed.id}`,
      certificateNo: seedCertificateNo(seed),
      credential,
    };
  }

  return {
    kind: 'seed',
    async listEntities(query) {
      const kind = query?.licenseKind;
      return SEED_ENTITIES.filter((e) => !kind || e.licenseKinds.includes(kind)).map((e) => ({ ...e }));
    },
    async getEntity(entityId) {
      const entity = SEED_ENTITIES.find((e) => e.id === entityId);
      return entity ? { ...entity } : null;
    },
    async listPartySigners(entityId) {
      return SEED_PARTY_SIGNERS.filter((s) => s.entityId === entityId).map((s) => ({ ...s }));
    },
    async getPartySigner(partySignerId) {
      const signer = SEED_PARTY_SIGNERS.find((s) => s.id === partySignerId);
      return signer ? { ...signer } : null;
    },
    async listPractitioners(entityId, query: PractitionerQuery) {
      // 與真實 adapter 相同：只回傳人員本身在查詢時點可簽章的人（證書失效、任職結束的人不在清單內）。
      // 業別層不在這裡排除，呼叫端要靠它說明原因
      const at = `${today()}T12:00:00+08:00`;
      return SEED_PRACTITIONERS.filter(
        (p) =>
          p.entityId === entityId &&
          p.certificateKind !== null &&
          query.certificateKinds.includes(p.certificateKind) &&
          (!query.fullTime || p.fullTime),
      )
        .map((p) => toCandidate(p, query.licenseKind))
        .filter(
          (c) =>
            credentialStatusAt({ ...c.credential, license: { state: 'verified', validUntil: null, latestCheckId: null } }, at).signable,
        );
    },
    async getPractitioner(practitionerId, query) {
      const seed = SEED_PRACTITIONERS.find((p) => p.id === practitionerId);
      return seed ? toCandidate(seed, query.licenseKind) : null;
    },
  };
}

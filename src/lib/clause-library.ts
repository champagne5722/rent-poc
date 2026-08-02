// 平台維護的範本與選用條款庫（ADR-0005、規格 §12）。
//
// 這裡的內容是「平台資料」而非使用者資料：PoC 用程式內常數表達，維護介面屬 Admin 後台（範圍外）。
// 兩者都版本化，合約建立時綁定當下版本並把條文整段快照進合約欄位，之後平台改版不回溯影響任何既有
// 合約與草稿；草稿若遇新版由 upgradeNotice() 產生提示，升版與否由房東決定（不強制）。

import type { ClauseSnapshot, ContractTemplate, OptionalClause, TemplateBinding } from './types';

/** 平台目前提供的唯一範本；架構支援多範本，首發一份（ADR-0005）。 */
export const DEFAULT_TEMPLATE: ContractTemplate = {
  id: 'residential-lease',
  name: '住宅租賃契約',
  version: 1,
  provider: '平台提供',
  note: '條款全文由平台維護並經法務審閱，房東只編輯欄位。',
};

/** 選用條款庫：逐約勾選後併入合約產出的條款區。 */
export const OPTIONAL_CLAUSES: readonly OptionalClause[] = [
  {
    id: 'pet',
    title: '寵物飼養',
    body: '乙方經甲方書面同意後，得於本房屋內飼養寵物，並應自行負責清潔與防疫；因飼養寵物致本房屋或其附屬設備毀損、鄰居受擾或產生異味者，乙方應負回復原狀及損害賠償責任。',
    version: 1,
  },
  {
    id: 'sublet',
    title: '禁止轉租',
    body: '乙方不得將本房屋之全部或一部轉租、出借、頂讓或以其他方式供他人使用；違反者甲方得逕行終止本契約，乙方並應賠償甲方因此所受之損害。',
    version: 1,
  },
  {
    id: 'early-exit',
    title: '提前解約違約金',
    body: '本契約租期屆滿前，任一方欲終止契約者，應於一個月前以書面通知他方，並給付相當於一個月租金之違約金予他方。',
    version: 1,
  },
  {
    id: 'utilities',
    title: '水電費分擔',
    body: '本房屋之水費、電費、瓦斯費及網路費，由乙方依實際用量或帳單金額負擔，並應於繳費期限前繳清；房屋稅、地價稅及大樓管理費由甲方負擔。',
    version: 1,
  },
] as const;

export function findClause(id: string, library: readonly OptionalClause[] = OPTIONAL_CLAUSES): OptionalClause | null {
  return library.find((clause) => clause.id === id) ?? null;
}

/**
 * 把勾選的條款 id 換成完整條文快照。
 * 順序照條款庫（合約條文順序才穩定）、重複只留一份、查無此條款直接忽略。
 */
export function snapshotClauses(
  ids: readonly string[],
  library: readonly OptionalClause[] = OPTIONAL_CLAUSES
): ClauseSnapshot[] {
  const wanted = new Set(ids);
  return library.filter((clause) => wanted.has(clause.id)).map((clause) => ({ ...clause }));
}

/** 建約（含複製為新草稿以外的新建路徑）時綁定當下的範本版本，並快照勾選條款。 */
export function bindTemplate(
  clauseIds: readonly string[] = [],
  options: { template?: ContractTemplate; library?: readonly OptionalClause[] } = {}
): Required<TemplateBinding> {
  const template = options.template ?? DEFAULT_TEMPLATE;
  return {
    templateId: template.id,
    templateVersion: template.version,
    clauses: snapshotClauses(clauseIds, options.library ?? OPTIONAL_CLAUSES),
  };
}

/** 讀合約自己的條款快照；早期沒有這欄的合約當成沒勾。一律不回頭查平台條款庫。 */
export function clauseSnapshots(binding: TemplateBinding): ClauseSnapshot[] {
  return binding.clauses ?? [];
}

export function selectedClauseIds(binding: TemplateBinding): string[] {
  return clauseSnapshots(binding).map((clause) => clause.id);
}

/**
 * wizard 改勾選時重算條款快照：已經勾著的沿用合約自己的舊快照，只有新勾的才取平台當下條文。
 * 這樣「改勾別條」不會順手把既有條款偷偷升版；要升版走 upgradedTemplateBinding()。
 * 已從平台下架但仍勾著的條款排在最後，快照原樣保留。
 */
export function reselectClauses(
  binding: TemplateBinding,
  ids: readonly string[],
  library: readonly OptionalClause[] = OPTIONAL_CLAUSES
): ClauseSnapshot[] {
  const wanted = new Set(ids);
  const kept = new Map(clauseSnapshots(binding).map((snapshot) => [snapshot.id, snapshot]));
  const fromLibrary = library
    .filter((clause) => wanted.has(clause.id))
    .map((clause) => kept.get(clause.id) ?? { ...clause });
  const retired = clauseSnapshots(binding).filter(
    (snapshot) => wanted.has(snapshot.id) && !findClause(snapshot.id, library)
  );
  return [...fromLibrary, ...retired];
}

/** 摘要用的範本標示：顯示合約綁的版本，不是平台當下的版本。 */
export function templateLabel(binding: TemplateBinding, template: ContractTemplate = DEFAULT_TEMPLATE): string {
  return binding.templateVersion == null
    ? `${template.name}（未綁定版本）`
    : `${template.name} v${binding.templateVersion}`;
}

export interface ClauseUpgrade {
  id: string;
  title: string;
  from: number;
  to: number;
}

export interface UpgradeNotice {
  /** 範本本身有新版時的新舊版號；沒有就是 null。 */
  template: { from: number; to: number } | null;
  /** 已勾選但平台有新版的條款。 */
  clauses: ClauseUpgrade[];
  hasUpgrade: boolean;
}

interface LibraryOptions {
  template?: ContractTemplate;
  library?: readonly OptionalClause[];
}

/**
 * 草稿的升版提示（規格 §12）：比對合約快照與平台當下版本。
 * 只提示、不改資料；已從平台下架的條款不提示（快照照舊留在合約裡）。
 * 早期沒綁範本的合約以版本 0 表示，一樣會提示可升版。
 */
export function upgradeNotice(binding: TemplateBinding, options: LibraryOptions = {}): UpgradeNotice {
  const template = options.template ?? DEFAULT_TEMPLATE;
  const library = options.library ?? OPTIONAL_CLAUSES;
  const boundVersion = binding.templateVersion ?? 0;
  const templateUpgrade =
    boundVersion < template.version ? { from: boundVersion, to: template.version } : null;
  const clauses = clauseSnapshots(binding).flatMap((snapshot) => {
    const latest = findClause(snapshot.id, library);
    if (!latest || latest.version <= snapshot.version) return [];
    return [{ id: snapshot.id, title: latest.title, from: snapshot.version, to: latest.version }];
  });
  return { template: templateUpgrade, clauses, hasUpgrade: templateUpgrade !== null || clauses.length > 0 };
}

/**
 * 升版＝重新快照：綁上最新範本版本，已勾條款重取平台最新條文。
 * 回傳新物件，原快照不被就地改寫；平台已下架的條款原樣保留。
 */
export function upgradedTemplateBinding(
  binding: TemplateBinding,
  options: LibraryOptions = {}
): Required<TemplateBinding> {
  const template = options.template ?? DEFAULT_TEMPLATE;
  const library = options.library ?? OPTIONAL_CLAUSES;
  return {
    templateId: template.id,
    templateVersion: template.version,
    clauses: clauseSnapshots(binding).map((snapshot) => {
      const latest = findClause(snapshot.id, library);
      return latest ? { ...latest } : { ...snapshot };
    }),
  };
}

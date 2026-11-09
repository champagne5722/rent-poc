// 可簽章判定 credentialStatusAt(facts, at)（ADR-0017 決議 6、8、13，ADR-0021 決議 4）。
// 純函式，沒有 I/O。時間由參數傳入，不讀系統時間。D 線先實作，C 線的 MIL-113 沿用。
//
// 判定：對應業別、證書、任職三層都是 verified，且任職期間涵蓋查詢時點，且查詢日不晚於證書的 valid_until。
// 換證窗口內（valid_until 前 6 個月內）仍可簽章，回傳期限讓畫面顯示。
// 原因一次列完，讓使用者一次補正。每層獨立判定，核對順序不受限。
//
// 輸入的形狀照 src/lib/registry-rules/README.md 的「MIL-113：可簽章判定事實」：
// 三層 CredentialState、valid_until、任職期間與最新核對紀錄 ID。

import {
  DEFAULT_TIMER_CONFIG,
  addMonths,
  isIsoDate,
  type CredentialLayer,
  type CredentialState,
} from '../registry-rules';

/** 業別與證書層。valid_until 是 YYYY-MM-DD 的台灣日期。 */
export interface LayerCredentialFacts {
  state: CredentialState | null;
  /** 證書層：已驗證時必須有。業別層：沒有代表不設期限。 */
  validUntil: string | null;
  /** 最新的核對紀錄 ID。簽章紀錄（MIL-70）存它，本函式不使用。 */
  latestCheckId: string | null;
}

/** 任職層。任職沒有效期，只有任職期間（ADR-0017 決議 4）。 */
export interface EmploymentCredentialFacts {
  state: CredentialState | null;
  startsOn: string;
  endsOn: string | null;
  latestCheckId: string | null;
}

export interface CredentialFacts {
  license: LayerCredentialFacts;
  practitioner: LayerCredentialFacts;
  employment: EmploymentCredentialFacts;
}

export type CredentialIssueCode =
  | 'invalid_time'
  | 'license_not_verified'
  | 'practitioner_not_verified'
  | 'employment_not_verified'
  | 'license_expired'
  | 'practitioner_expired'
  | 'practitioner_valid_until_missing'
  | 'employment_not_started'
  | 'employment_ended'
  | 'license_invalid_date'
  | 'practitioner_invalid_date'
  | 'employment_invalid_date';

export interface CredentialIssue {
  code: CredentialIssueCode;
  /** 時間本身壞掉時沒有對應的層。 */
  layer: CredentialLayer | null;
  message: string;
}

/** 換證窗口：證書在 validUntil 期滿，從 windowStartsOn 起進入窗口。 */
export interface RenewalWindow {
  validUntil: string;
  windowStartsOn: string;
}

export type CredentialStatus =
  | { signable: true; renewalWindow: RenewalWindow | null }
  | { signable: false; issues: CredentialIssue[] };

export interface CredentialStatusConfig {
  /** 換證窗口月數，預設沿用 C 線的計時器設定（6 個月）。 */
  renewalWindowMonths: number;
}

const LAYER_LABELS: Record<CredentialLayer, string> = {
  license: '業別',
  practitioner: '證書',
  employment: '任職',
};

const STATE_TEXT: Record<CredentialState | 'none', string> = {
  none: '尚未登錄',
  pending: '待驗證',
  verified: '已驗證',
  lapsed: '已失效',
};

/** ISO 8601 時間換成台灣日期（UTC+8）。不是有效時間回 null。 */
function taiwanDateOf(at: string): string | null {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function issue(code: CredentialIssueCode, layer: CredentialLayer | null, message: string): CredentialIssue {
  return { code, layer, message };
}

function notVerified(layer: CredentialLayer, state: CredentialState | null): CredentialIssue {
  return issue(
    `${layer}_not_verified`,
    layer,
    `${LAYER_LABELS[layer]}${STATE_TEXT[state ?? 'none']}`,
  );
}

/**
 * @param at 查詢時點，ISO 8601。簽署當下用事件時間，送簽時用送簽時間（ADR-0018 決議 11）。
 */
export function credentialStatusAt(
  facts: CredentialFacts,
  at: string,
  config: CredentialStatusConfig = { renewalWindowMonths: DEFAULT_TIMER_CONFIG.renewalWindowMonths },
): CredentialStatus {
  const date = taiwanDateOf(at);
  if (date === null) {
    return { signable: false, issues: [issue('invalid_time', null, '判定時間格式不正確')] };
  }

  const issues: CredentialIssue[] = [];
  let renewalWindow: RenewalWindow | null = null;

  const { license, practitioner, employment } = facts;

  // 業別層：有登錄效期才比對
  if (license.state !== 'verified') {
    issues.push(notVerified('license', license.state));
  } else if (license.validUntil !== null) {
    if (!isIsoDate(license.validUntil)) {
      issues.push(issue('license_invalid_date', 'license', '業別的效期格式不正確'));
    } else if (date > license.validUntil) {
      issues.push(issue('license_expired', 'license', `業別已於 ${license.validUntil} 期滿`));
    }
  }

  // 證書層：一定比對效期，沒有登錄效期就不放行
  if (practitioner.state !== 'verified') {
    issues.push(notVerified('practitioner', practitioner.state));
  } else if (practitioner.validUntil === null) {
    issues.push(issue('practitioner_valid_until_missing', 'practitioner', '證書沒有登錄效期'));
  } else if (!isIsoDate(practitioner.validUntil)) {
    issues.push(issue('practitioner_invalid_date', 'practitioner', '證書的效期格式不正確'));
  } else if (date > practitioner.validUntil) {
    issues.push(issue('practitioner_expired', 'practitioner', `證書已於 ${practitioner.validUntil} 期滿`));
  } else {
    const windowStartsOn = addMonths(practitioner.validUntil, -config.renewalWindowMonths);
    if (date >= windowStartsOn) renewalWindow = { validUntil: practitioner.validUntil, windowStartsOn };
  }

  // 任職層：任職期間必須涵蓋查詢時點
  if (employment.state !== 'verified') {
    issues.push(notVerified('employment', employment.state));
  } else if (!isIsoDate(employment.startsOn) || (employment.endsOn !== null && !isIsoDate(employment.endsOn))) {
    issues.push(issue('employment_invalid_date', 'employment', '任職期間的日期格式不正確'));
  } else if (date < employment.startsOn) {
    issues.push(issue('employment_not_started', 'employment', `任職從 ${employment.startsOn} 起算，尚未開始`));
  } else if (employment.endsOn !== null && date > employment.endsOn) {
    issues.push(issue('employment_ended', 'employment', `任職已於 ${employment.endsOn} 結束`));
  }

  return issues.length > 0 ? { signable: false, issues } : { signable: true, renewalWindow };
}

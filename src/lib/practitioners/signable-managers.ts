import { credentialStatusAt } from '../credential-status';
import type { OrgEmployment } from './applicant';

// 「可簽章的租賃住宅管理人員」的判定（ADR-0017 決議 6）。純函式，沒有 I/O。
// 這是整個系統唯一的一份判定：建案入口的資格事實（loadPracticeEligibility）與業者接受申請時指派管理人員
// （MIL-210）都用它，不另寫第二份。業別層由呼叫端先確認（任一已驗證的業別），這裡只判證書與任職兩層，
// 並用 credentialStatusAt 判定任職期間與證書效期涵蓋 now。

/** 這位任職的人是不是租賃住宅管理人員，業別、證書、任職三層都已驗證，期間涵蓋 now。 */
export function isSignableManager(employment: OrgEmployment, now: Date): boolean {
  return (
    employment.certificateKind === 'rental_housing_manager' &&
    credentialStatusAt(
      {
        license: { state: 'verified', validUntil: null, latestCheckId: null },
        practitioner: { state: employment.practitionerState, validUntil: employment.validUntil, latestCheckId: null },
        employment: { state: employment.state, startsOn: employment.startedOn, endsOn: employment.endedOn, latestCheckId: null },
      },
      now.toISOString(),
    ).signable
  );
}

export function signableManagers(employments: readonly OrgEmployment[], now: Date): OrgEmployment[] {
  return employments.filter((employment) => isSignableManager(employment, now));
}

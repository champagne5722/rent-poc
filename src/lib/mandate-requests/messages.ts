import type { MandateRequestKind } from './status';

// 申請流程的固定文字（MIL-206）。同一類拒絕一律用同一句，不因原因不同而改字，
// 否則回應的差異會讓人推出不該知道的事（ADR-0028 決議 1，ADR-0029 決議 5、9）。

/** 申請的法定名稱。平台不另立統稱（ADR-0030）。 */
export const KIND_LABEL: Readonly<Record<MandateRequestKind, string>> = {
  management: '委託管理申請',
  master_lease: '住宅包租申請',
};

/**
 * 連結頁在登入前對所有無效連結的回應：查無此碼、格式錯誤、已過期、已收回、已被別的組織綁定、業別已失效。
 * 狀態碼與本文必須逐位元相同。
 */
export const LINK_INVALID_MESSAGE = '連結無效或已失效，請向業者索取新的連結';

/** 申請不存在、不屬於呼叫者的組織、或呼叫者不是這份申請的當事人。 */
export const REQUEST_NOT_FOUND_MESSAGE = '找不到這份申請';

export const NOT_OWNER_ORG_MESSAGE = '這個帳號屬於業者或其他類型的組織，不能以屋主身分開啟申請連結。請改用屋主的帳號登入';
export const OWNER_NAME_REQUIRED_MESSAGE = '第一次使用請填屋主名稱';
export const IDENTITY_NOT_CHOSEN_MESSAGE = '這個帳號有多個身分，請先切換成屋主身分再開啟連結';

/** 租賃單位已被進行中的申請、有效的委託或有效的包租佔用。不提是哪一家業者，也不提是哪一種原因。 */
export const UNITS_UNAVAILABLE_MESSAGE = '這個租賃單位已有進行中的申請或有效的委託，請先處理';
export const UNIT_NOT_FOUND_MESSAGE = '找不到這個租賃單位';
export const NO_UNITS_MESSAGE = '請至少選一個租賃單位';

export const REQUEST_EXPIRED_MESSAGE = '這份申請已經失效，請向業者索取新的連結';
export const REQUEST_NOT_PENDING_OWNER_MESSAGE = '這份申請已經送出或已結束，不能再送出';
export const NOT_SUBMITTED_MESSAGE = '這份申請還沒有送出，不需要收回，離開頁面即可';
export const NOT_WITHDRAWABLE_MESSAGE = '這份申請已經不能收回';

export const NO_DRAFT_MESSAGE = '這份申請沒有業者代填的資料';

export const LICENSE_NOT_VERIFIED_MESSAGE = '貴公司的這個業別還沒通過驗證，不能產生這種申請連結';
export const PRACTICE_ORG_REQUIRED_MESSAGE = '只有代管業者或包租業者的組織能產生申請連結';

/** 站內通知文字。只寫申請的種類與租賃單位的數量，不帶屋主的 email 與名稱。待法務確認。 */
export const SUBMITTED_NOTICE_TITLE = (kind: MandateRequestKind) => `收到一份${KIND_LABEL[kind]}`;
export const SUBMITTED_NOTICE_BODY = (kind: MandateRequestKind, unitCount: number) =>
  `屋主送出了一份${KIND_LABEL[kind]}，含 ${unitCount} 個租賃單位。`;
export const WITHDRAWN_NOTICE_TITLE = '申請已收回';
export const WITHDRAWN_NOTICE_BODY = (kind: MandateRequestKind) => `屋主收回了一份${KIND_LABEL[kind]}。`;

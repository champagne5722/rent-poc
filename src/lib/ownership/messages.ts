import type { OwnershipCheckResult } from './status';

// 所有權核對給使用者看的固定文字（MIL-201，ADR-0028 決議 3）。畫面與通知直接用這裡的常數。
// 規則：訊息不提到任何別人，也不因為別的組織是否登錄過同一個鍵而不同。
// 每句 40 字以內。法律用語與通知文字待法務確認（MIL-62）。

/** 建號不符。ADR-0028 決議 3 固定的字樣。 */
export const KEY_MISMATCH_MESSAGE = '建號與你的謄本不符，請修正';

/** 登記名義人不符。說明要補的文件。 */
export const HOLDER_MISMATCH_MESSAGE =
  '謄本的登記名義人與你主張的所有權人不符。請更換成登記名義人相符的謄本，或補上說明兩者關係的文件。';

/** 「已核對」的說明文字。固定字樣，不寫成保證（ADR-0026 決議 7）。 */
export const VERIFIED_NOTE = '平台已比對出租權源文件';

/** 已送出、等待核對時顯示。 */
export const AWAITING_REVIEW_MESSAGE = '文件已送出，等待平台核對';

/** 還沒上傳謄本時顯示。 */
export const NOT_SUBMITTED_MESSAGE = '請上傳第二類謄本，平台會核對所有權';

/** 通過核對後修正建號，改送平台審核。 */
export const REKEY_REVIEW_MESSAGE = '物件已核對，修正建號需要平台審核。已送出申請';

/** 核對中不能修正建號。 */
export const REKEY_LOCKED_WHILE_PENDING_MESSAGE = '文件正在核對，核對完成後才能修正建號';

/** 站內通知：核對通過。 */
export const VERIFIED_NOTIFICATION = {
  kind: 'property.verification_passed',
  title: '物件已通過文件核對',
  body: `${VERIFIED_NOTE}。現在可以建立案件。`,
} as const;

/** 站內通知：核對未通過。 */
export const FAILED_NOTIFICATION_KIND = 'property.verification_failed';
export const FAILED_NOTIFICATION_TITLE = '物件的文件核對未通過';

/** 不符項目對應的訊息，依序列出。兩項都相符回空陣列。 */
export function mismatchMessages(result: OwnershipCheckResult): string[] {
  const messages: string[] = [];
  if (!result.keyMatch) messages.push(KEY_MISMATCH_MESSAGE);
  if (!result.holderMatch) messages.push(HOLDER_MISMATCH_MESSAGE);
  return messages;
}

/** 核對未通過的站內通知本文。 */
export function failedNotificationBody(result: OwnershipCheckResult): string {
  return `${mismatchMessages(result).join('\n')}\n請到物件頁修正後重新送出。`;
}

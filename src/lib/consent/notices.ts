import { createHash } from 'node:crypto';

// 告知文字（PRD P0-24，MIL-84）。程式內的常數，帶類型與版本，是唯一的來源。
//
// 規則：
// - 文字改版時新增一個版本，不得修改已發佈版本的文字。舊紀錄存的是當時的版本號與文字雜湊，
//   所以舊版要留在清單裡，才能還原當時顯示的文字。
// - 第一版的文字依 PRD 的保守假設撰寫，每一版都標示「待法務確認」，清單在 Linear MIL-62（第 8 題）。
//   法務確認後，新增一個版本，把 legalReview 改為 approved，並拿掉文字內的標示。
// - 同意紀錄存文字的 SHA-256，不存文字本身（recordConsent 在寫入時由這裡的文字算出）。

export const NOTICE_TYPES = ['esign', 'transcript_id_pii', 'certificate_pii', 'case_data_sharing'] as const;

/**
 * esign：電子簽署告知，對象是每位簽署人，送簽前。
 * transcript_id_pii：謄本與身分證件個資告知，對象是上傳者，第一次上傳前。
 * certificate_pii：證書資料個資告知，對象是執業人員，登錄證書前。
 * case_data_sharing：案件資料共享告知，對象是委託人，委託管理合約送簽前。
 */
export type NoticeType = (typeof NOTICE_TYPES)[number];

export type LegalReviewStatus = 'pending' | 'approved';

export interface NoticeVersion {
  /** 從 1 起連續遞增的整數。 */
  version: number;
  title: string;
  text: string;
  legalReview: LegalReviewStatus;
}

export type NoticeCatalog = Readonly<Record<NoticeType, readonly NoticeVersion[]>>;

const PENDING_MARK = '【待法務確認】本文為第一版草稿，內容待法務確認後才會定稿。\n\n';

export const NOTICE_CATALOG: NoticeCatalog = {
  esign: [
    {
      version: 1,
      title: '電子簽署告知',
      legalReview: 'pending',
      text:
        PENDING_MARK +
        '本合約將以電子方式簽署，不使用紙本。\n' +
        '依電子簽章法，使用電子文件與電子簽章，必須取得你的同意。\n' +
        '簽署時，系統會透過第三方電子簽署服務寄送簽署連結到你的電子郵件信箱。\n' +
        '簽署服務會蒐集你的姓名、電子郵件、簽署時間與簽署紀錄，用來完成簽署與日後舉證。\n' +
        '你可以選擇反對以電子方式簽署。選擇反對後，本平台不會送出電子簽署，請改用紙本簽約。\n' +
        '你同意後，仍可在簽署前改變決定。改變決定時，請通知寄送本告知的一方。\n' +
        '你的同意或反對、告知版本與時間，都會被保存。',
    },
  ],
  transcript_id_pii: [
    {
      version: 1,
      title: '謄本與身分證件個資告知',
      legalReview: 'pending',
      text:
        PENDING_MARK +
        '你要上傳土地或建物謄本，或身分證件資料。上傳前，請先閱讀以下告知。\n' +
        '蒐集機關：本平台營運者。\n' +
        '蒐集目的：確認出租人對租賃標的有權出租，並辦理合約簽署與風險控管。\n' +
        '蒐集項目：謄本上的登記名義人、建號、地號與權利範圍。身分證件上的姓名與證件字號。\n' +
        '利用方式：只供本平台人員與你授權的案件成員，在上述目的範圍內查閱。\n' +
        '利用期間：保存期限待法務確認。\n' +
        '你可以請求查詢、閱覽、複製、補充、更正、停止蒐集處理利用，或刪除這些資料。\n' +
        '你可以不提供這些資料，但本平台可能無法驗證出租權源，也無法繼續送簽。\n' +
        '你同意後才能上傳。你反對時，本平台不會接受這些資料。',
    },
  ],
  certificate_pii: [
    {
      version: 1,
      title: '證書資料個資告知',
      legalReview: 'pending',
      text:
        PENDING_MARK +
        '你要登錄不動產經紀營業員、經紀人或管理人員的證書資料。登錄前，請先閱讀以下告知。\n' +
        '蒐集機關：本平台營運者。\n' +
        '蒐集目的：確認你具備執業資格，並指派你擔任合約簽章人員。\n' +
        '蒐集項目：姓名、證書類別與字號、有效期限、任職的執業主體，以及證明文件。\n' +
        '利用方式：供本平台審核人員核對，並在合約與簽章欄顯示你的姓名與資格。\n' +
        '利用期間：證書影本的保存期限與遮罩方式待法務確認。\n' +
        '你可以請求查詢、閱覽、複製、補充、更正、停止蒐集處理利用，或刪除這些資料。\n' +
        '你可以不提供這些資料，但本平台無法確認你的資格，你將不能擔任簽章人員。\n' +
        '你同意後才能登錄。你反對時，本平台不會接受這些資料。',
    },
  ],
  case_data_sharing: [
    {
      version: 1,
      title: '案件資料共享告知',
      legalReview: 'pending',
      text:
        PENDING_MARK +
        '你要委託代管業者處理你的租賃案件。送出委託管理合約前，請先閱讀以下告知。\n' +
        '受託的代管業者在委託範圍內，可以查看該案件的合約、帳務、押金、修繕與點交紀錄。\n' +
        '受託的代管業者也可以查看承租人的姓名與聯絡方式，用來履行委託事項。\n' +
        '代管業者不能查看你名下其他租賃單位的資料，除非你另外委託。\n' +
        '你終止委託後，代管業者不能再查看該案件的新資料。\n' +
        '共享範圍與保存期限待法務確認。\n' +
        '你同意後才能送出委託管理合約。你反對時，請改用自管或其他方式處理。',
    },
  ],
};

/** 文字的 SHA-256：對 UTF-8 位元組計算，小寫十六進位。 */
export function textSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 目前版本：清單內最高的版本。 */
export function currentNotice(catalog: NoticeCatalog, type: NoticeType): NoticeVersion {
  const versions = catalog[type];
  return versions.reduce((a, b) => (b.version > a.version ? b : a));
}

/** 找指定版本，包含舊版。找不到回傳 undefined。 */
export function findNotice(catalog: NoticeCatalog, type: NoticeType, version: number): NoticeVersion | undefined {
  return catalog[type].find((v) => v.version === version);
}

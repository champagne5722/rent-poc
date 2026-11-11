// 稽核事件的動作名稱（ADR-0019，MIL-82）。程式內的常數清單，是唯一的來源。
//
// 規則：
// - 格式是 `領域.動詞`，小寫英數與底線，與資料庫 audit.events 的 CHECK 一致。
// - 新增動作時只改這裡。appendAudit 在執行期拒絕清單外的動作，verifyChain 把清單外的動作當成問題回報。
// - 動作名稱一旦寫進事件就刪不掉。已用過的名稱不得改名，只能新增。
// - 範圍依 PRD P0-23 與架構 4.7。各線補自己的動作時，附上對應的票號。

export const AUDIT_ACTIONS = [
  // 營運者與維運（MIL-82）
  'operator.access', // 平台營運者存取組織資料，withTx 的 operator 脈絡自動寫入
  'break_glass.start', // 維運事故使用 break-glass 角色，開始
  'break_glass.end', // 結束

  // 權限（PRD P0-23：成員與權限變更、承租人登入、移交生效）
  'member.grant', // 成員加入組織。建組織時的第一位 admin、被邀請者登入後成為成員（MIL-106）
  'member.revoke', // 成員被移除。同交易刪除該帳號以此組織為身分的 session（MIL-106）
  'member.role_change',
  'member.invite', // MIL-106：admin 以 email 邀請，payload 放角色與邀請 ID，不放 email
  'member.invite_cancel',
  'org.create', // MIL-106：第一次登入時建立屋主或執業主體組織，寫進新組織自己的鏈
  'tenant.login',
  'auth.login', // MIL-103：屋主、經理人、營運者登入。有組織身分時寫該組織的鏈，其餘寫平台鏈。payload 放 actor_identity_level
  'auth.logout',
  'auth.membership_rejected', // MIL-103：每個請求重查成員資格，失效時拒絕並留紀錄（P0-02 AC6）
  'handover.take_effect',

  // 判定（出租權源判定、重複審核判定、執業主體與執業人員驗證）
  'rental_right.judge',
  'rental_right.verify',
  'rental_right.revoke',
  'duplicate_review.judge',
  'practice_entity.verify',
  'practice_entity.register', // MIL-106：經理人送出統編登錄。統編已被別人登錄時（改排審核台）事件也一樣，不讓匯出稽核的人推出別的組織存在
  'practice_entity.submit', // MIL-109：執業主體送出業別與證字號，寫在送件組織自己的鏈。payload 只放業別與狀態轉移，不放證字號
  'practice_entity.claim_resolve', // MIL-109：營運者判定第二個組織認領同一統編的歸屬，寫在平台組織的鏈
  'practitioner.verify', // MIL-111：營運者核對證書、任職、同意書，寫在平台組織的鏈。payload 放核對紀錄 ID、層級、結果與狀態轉移
  'practitioner.submit', // MIL-111：執業人員本人登錄或補件證書，寫在登錄者組織的鏈。payload 只放證書種類與狀態轉移，不放證號
  'employment.create', // MIL-111：建立待驗證任職，payload 放任職 ID、證書種類與是否需要同意書
  'employment.end', // MIL-111：結束任職，payload 放任職 ID 與結束日

  // 規則（專任阻擋與提示、簽章人員指派、狀態改為已失效）
  'rule.full_time_block', // MIL-111：專任規則阻擋（建立任職或營運者核對相符），payload 放證號、時間與原因，不放別的組織的任何資料
  'rule.full_time_notice', // MIL-111：專任規則提示（經紀人員掛第二家要求同意書，或同意書尚未核對），payload 同上
  'signer.assign',
  'signature.route',
  'contract.invalidate',

  // 物件身分、合約
  'property.create', // MIL-81：物件建立、修改、刪除，payload 只放租賃單位 ID 與被改的欄位名稱
  'property.update',
  'property.delete',
  'property.anchor_key', // MIL-143：補建號，payload 只放租賃單位 ID，不放鍵與地址
  'property.anchor_collision', // MIL-144、MIL-196：鍵撞到別的組織，已送審核台。只寫在平台組織的鏈（由資料庫函式寫入），宣稱方的鏈沒有這筆事件。payload 只放宣稱方組織 ID 與審核單號，不放鍵與對方的任何資料
  'property.anchor_collision_limited', // MIL-144：24 小時內的撞號回應超過上限，建立失敗。MIL-196 起不再寫入：超過次數改為審核台的內部警示。名稱保留，因為已寫入的事件刪不掉
  'property.sublet_create', // MIL-145：新增分租單位，payload 只放租賃單位 ID 與單位後綴，不放房號與地址
  'property.archive', // MIL-145：有合約的物件刪除時改為封存，payload 只放租賃單位 ID
  'ownership.submit', // MIL-201：送出第二類謄本，寫在送件組織自己的鏈。payload 只放送件 ID、是否有信託登記與檔案大小，不放姓名與檔名
  'request.create', // MIL-206：業者產生申請連結，寫在業者的鏈。payload 只放申請 ID、種類與是否有代填資料，不放碼與代填內容
  'request.claim', // MIL-206：屋主組織第一次綁定連結，寫在屋主的鏈。業者的鏈沒有這筆事件
  'request.confirm_draft', // MIL-206：屋主確認業者代填的資料，寫在屋主的鏈。payload 放申請 ID、租賃單位 ID 與是否轉入謄本
  'request.submit', // MIL-206：屋主送出申請，寫在屋主的鏈。payload 放申請 ID 與租賃單位數量
  'request.withdraw', // MIL-206：屋主收回申請，寫在屋主的鏈。payload 只放申請 ID
  'request.attach_file', // MIL-206：業者代傳謄本，寫在業者的鏈。payload 只放檔案大小，不放檔名與謄本表單欄位
  'request.file_read', // MIL-206：業者讀自己代傳的謄本原檔，寫在業者的鏈。payload 只放申請 ID
  'contract.create', // MIL-83：合約的建立、複製、刪除。payload 只放 ID 與類型，不放姓名、地址、租金
  'contract.copy',
  'contract.delete',
  'anchor.merge',
  'handover.seal',
  'handover.accept',
  'contract.signed_hash',

  // 案件（MIL-115）。狀態轉移不在這裡：案件事件表已完整記錄，這裡只記建立、成員異動與未結結案
  'case.create', // 建立案件，payload 放案件種類與業務類型
  'case_member.add', // 加入案件成員，payload 放案件 ID、關係與 party ID，不放 email
  'case_member.replace_email', // 更新承租人 email（MIL-121，P0-21 AC5），payload 放關係、舊與新的 party ID，不放 email
  'case.unsettled_close', // 有未結事項仍結案（ADR-0016 決議 6），payload 放未結原因

  // 告知與同意（P0-24，MIL-84）
  'consent.record',

  // 敏感文件（含讀取）
  'vault.read',
  'vault.upload', // MIL-109：證據檔登記，payload 放檔案 ID、對象與大小，不放檔名
  'vault.delete', // MIL-109：證據檔刪除，payload 放原因與刪除方式（ADR-0017 補充，P0-04 AC5）

  // 收款帳戶（MIL-118）：payload 只放 ID、持有人種類與帳戶性質，不放姓名與銀行識別
  'payment_account.register',
  'payment_account.update',
  'payment_account.deactivate',

  // 接上案件的帳務設定（MIL-123）：payload 只放 ID、數量與旗標值，不放戶名、帳號與原因（原因存在修改紀錄表）
  'case_ledger.open', // 合約全員完成，同交易建立押金台帳與應收期別
  'case_ledger.cancel_periods', // 合約提前終止，終止日之後的期別改 cancelled
  'case.social_housing_change', // 修改社宅旗標，原因存在 org.case_social_housing_changes
  'case_remitter.add', // 登錄匯款識別，payload 只放種類
  'case_remitter.remove',
  'case.default_accounts_set', // 設定租金與押金的預設收款帳戶，payload 只放帳戶 ID

  // 帳務（鏡像帳與押金分錄、報表產生、手動繳租提醒）
  'ledger.entry',
  'ledger.reverse',
  'deposit.confirm',
  'report.generate',
  'rent_reminder.manual',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const KNOWN: ReadonlySet<string> = new Set(AUDIT_ACTIONS);

export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === 'string' && KNOWN.has(value);
}

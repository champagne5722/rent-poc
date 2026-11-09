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
  'practitioner.verify',

  // 規則（專任阻擋與提示、簽章人員指派、狀態改為已失效）
  'rule.full_time_block',
  'signer.assign',
  'signature.route',
  'contract.invalidate',

  // 物件身分、合約
  'property.create', // MIL-81：物件建立、修改、刪除，payload 只放租賃單位 ID 與被改的欄位名稱
  'property.update',
  'property.delete',
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
  'case.unsettled_close', // 有未結事項仍結案（ADR-0016 決議 6），payload 放未結原因

  // 告知與同意（P0-24，MIL-84）
  'consent.record',

  // 敏感文件（含讀取）
  'vault.read',
  'vault.upload', // MIL-109：證據檔登記，payload 放檔案 ID、對象與大小，不放檔名
  'vault.delete', // MIL-109：證據檔刪除，payload 放原因與刪除方式（ADR-0017 補充，P0-04 AC5）

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

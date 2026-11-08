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
  'member.grant',
  'member.revoke',
  'member.role_change',
  'tenant.login',
  'handover.take_effect',

  // 判定（出租權源判定、重複審核判定、執業主體與執業人員驗證）
  'rental_right.judge',
  'rental_right.verify',
  'rental_right.revoke',
  'duplicate_review.judge',
  'practice_entity.verify',
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

  // 告知與同意（P0-24，MIL-84）
  'consent.record',

  // 敏感文件（含讀取）
  'vault.read',

  // 收款帳戶（MIL-118）：payload 只放 ID、持有人種類與帳戶性質，不放姓名與銀行識別
  'payment_account.register',
  'payment_account.update',
  'payment_account.deactivate',

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

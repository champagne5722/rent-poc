// 現況基準（MIL-170）的頁面清單。範圍取自 MIL-167 的五個階段，承租人端與 demo 頁不在範圍內。
// `sources` 是這一頁專屬的原始碼（頁面檔加專屬元件）。靜態統計（inline style、寫死色碼、antd 已棄用 API）只算這些檔。
// 共用的殼層（AppShell、OwnerShell）與 DisplayCode 等跨頁元件另列一行「共用」，不重複算進每一頁。

export type Role = 'owner' | 'practice' | 'operator' | 'tenant' | 'anonymous';

export interface PageSpec {
  /** 檔名與報告用的代號，兩位數流水號加英文短名。 */
  id: string;
  title: string;
  /** MIL-167 的階段：2 核心流程、3 列表、4 其他頁面、1 基礎（設計展示頁）。 */
  phase: 1 | 2 | 3 | 4;
  /** 版型分類，用來看「一致」：列表、詳情、精靈、面板、總覽、登入。 */
  layout: '列表' | '詳情' | '精靈' | '面板' | '總覽' | '登入' | '表單';
  role: Role;
  /** 路由樣板，{名稱} 由資料準備填入。 */
  route: string;
  sources: string[];
}

const WIZARD = ['src/components/ContractWizard.tsx', 'src/components/contract-wizard', 'src/components/RoutingConditionsPanel.tsx'];
const CASE = ['src/components/CaseDetail.tsx'];

export const PAGES: PageSpec[] = [
  { id: '01-workbench', title: '工作台', phase: 4, layout: '總覽', role: 'owner', route: '/', sources: ['src/app/(workbench)/page.tsx', 'src/components/Workbench.tsx'] },
  { id: '02-contracts-list', title: '合約列表', phase: 3, layout: '列表', role: 'owner', route: '/contracts', sources: ['src/app/contracts/(list)/page.tsx', 'src/components/ContractList.tsx'] },
  {
    id: '03-contract-detail-signing',
    title: '合約詳情（簽署中）',
    phase: 2,
    layout: '詳情',
    role: 'owner',
    route: '/contracts/{signing}',
    sources: ['src/app/contracts/[id]/page.tsx', 'src/components/SignatureFieldEditor.tsx'],
  },
  {
    id: '04-contract-detail-completed',
    title: '合約詳情（已完成）',
    phase: 2,
    layout: '詳情',
    role: 'owner',
    route: '/contracts/{completed}',
    sources: ['src/app/contracts/[id]/page.tsx'],
  },
  {
    id: '05-contract-detail-draft',
    title: '合約詳情（草稿）',
    phase: 2,
    layout: '詳情',
    role: 'owner',
    route: '/contracts/{readyDraft}',
    sources: ['src/app/contracts/[id]/page.tsx'],
  },
  {
    id: '06-contract-detail-declined',
    title: '合約詳情（已拒簽）',
    phase: 2,
    layout: '詳情',
    role: 'owner',
    route: '/contracts/{declined}',
    sources: ['src/app/contracts/[id]/page.tsx'],
  },
  { id: '07-wizard-1-property', title: '建約精靈 步驟一 物件摘要', phase: 2, layout: '精靈', role: 'owner', route: '/contracts/new?property={property}&kind=lease', sources: ['src/app/contracts/new/page.tsx', 'src/app/contracts/new/NewContractWizard.tsx', ...WIZARD] },
  { id: '08-wizard-2-fields', title: '建約精靈 步驟二 填欄位', phase: 2, layout: '精靈', role: 'owner', route: '/contracts/{bareDraft}/edit', sources: ['src/app/contracts/[id]/edit/page.tsx', ...WIZARD] },
  { id: '09-wizard-3-signature', title: '建約精靈 步驟三 簽署區', phase: 2, layout: '精靈', role: 'owner', route: '/contracts/{readyDraft}/edit', sources: ['src/app/contracts/[id]/edit/page.tsx', 'src/components/SignatureFieldEditor.tsx', ...WIZARD] },
  { id: '10-wizard-4-confirm', title: '建約精靈 步驟四 確認送簽', phase: 2, layout: '精靈', role: 'owner', route: '/contracts/{readyDraft}/edit', sources: ['src/app/contracts/[id]/edit/page.tsx', ...WIZARD] },
  { id: '11-properties-list', title: '物件列表', phase: 3, layout: '列表', role: 'owner', route: '/properties', sources: ['src/app/properties/page.tsx', 'src/components/AnchorFields.tsx'] },
  { id: '12-property-detail', title: '物件詳情', phase: 3, layout: '詳情', role: 'owner', route: '/properties/{property}', sources: ['src/app/properties/[id]/page.tsx', 'src/components/AnchorFields.tsx'] },
  { id: '13-cases-list', title: '案件列表', phase: 4, layout: '列表', role: 'owner', route: '/cases', sources: ['src/app/cases/(list)/page.tsx', 'src/components/CaseList.tsx'] },
  { id: '14-case-detail-overview', title: '案件詳情（概況）', phase: 4, layout: '詳情', role: 'owner', route: '/cases/{case}', sources: ['src/app/cases/[id]/(detail)/page.tsx', ...CASE] },
  { id: '15-case-detail-ledger', title: '案件詳情（帳務設定）', phase: 4, layout: '詳情', role: 'owner', route: '/cases/{case}#ledger', sources: ['src/app/cases/[id]/(detail)/page.tsx', ...CASE, 'src/components/CaseLedgerPanel.tsx'] },
  { id: '16-payment-accounts', title: '收款帳戶', phase: 4, layout: '列表', role: 'owner', route: '/payment-accounts', sources: ['src/app/payment-accounts/(list)/page.tsx', 'src/components/PaymentAccountList.tsx'] },
  { id: '17-notifications', title: '站內通知', phase: 4, layout: '列表', role: 'owner', route: '/notifications', sources: ['src/app/notifications/(list)/page.tsx', 'src/components/NotificationList.tsx'] },
  { id: '18-members', title: '成員設定', phase: 4, layout: '面板', role: 'owner', route: '/settings/members', sources: ['src/app/settings/members/(list)/page.tsx', 'src/components/MembersPanel.tsx'] },
  { id: '19-owner-overview', title: '屋主資產總覽', phase: 4, layout: '總覽', role: 'owner', route: '/owner', sources: ['src/app/owner/(overview)/page.tsx', 'src/components/OwnerOverview.tsx', 'src/components/OwnerOverview.module.css'] },
  { id: '20-owner-handovers', title: '屋主端 移交清單', phase: 4, layout: '列表', role: 'owner', route: '/owner/handovers', sources: ['src/app/owner/handovers/(list)', 'src/app/owner/handovers/HandoverParts.tsx', 'src/app/owner/handovers/handovers.module.css'] },
  { id: '21-owner-handover-new', title: '屋主端 發起移交', phase: 4, layout: '表單', role: 'owner', route: '/owner/handovers/new', sources: ['src/app/owner/handovers/new'] },
  { id: '22-owner-handover-detail', title: '屋主端 移交詳情', phase: 4, layout: '詳情', role: 'owner', route: '/owner/handovers/{handover}', sources: ['src/app/owner/handovers/[id]/(detail)', 'src/app/owner/handovers/HandoverParts.tsx'] },
  { id: '23-owner-case-detail', title: '屋主端 案件詳情', phase: 4, layout: '詳情', role: 'owner', route: '/owner/cases/{case}', sources: ['src/app/owner/cases/[id]/page.tsx', ...CASE] },
  { id: '24-org-handovers', title: '後台 移交清單', phase: 4, layout: '列表', role: 'practice', route: '/handovers', sources: ['src/app/handovers/(list)', 'src/app/handovers/NoOrgSession.tsx'] },
  { id: '25-org-handover-detail', title: '後台 移交詳情', phase: 4, layout: '詳情', role: 'practice', route: '/handovers/{orgHandover}', sources: ['src/app/handovers/[id]/(detail)'] },
  { id: '26-practice', title: '執業主體', phase: 4, layout: '面板', role: 'practice', route: '/practice', sources: ['src/app/practice/(page)/page.tsx', 'src/components/PracticePanel.tsx', 'src/components/EmploymentList.tsx'] },
  { id: '27-practitioner', title: '我的證書（執業人員）', phase: 4, layout: '面板', role: 'practice', route: '/practitioner', sources: ['src/app/practitioner/(page)/page.tsx', 'src/components/PractitionerPanel.tsx'] },
  { id: '28-desk-queue', title: '審核台佇列', phase: 4, layout: '列表', role: 'operator', route: '/desk', sources: ['src/app/desk/(list)/page.tsx', 'src/components/DeskQueue.tsx'] },
  { id: '29-desk-item-license', title: '審核台項目（業別核對）', phase: 4, layout: '詳情', role: 'operator', route: '/desk/items/{deskLicense}', sources: ['src/app/desk/items/[id]/page.tsx', 'src/components/DeskItemPanel.tsx', 'src/components/CredentialReviewPanel.tsx'] },
  { id: '30-desk-item-credential', title: '審核台項目（證書或任職核對）', phase: 4, layout: '詳情', role: 'operator', route: '/desk/items/{deskCredential}', sources: ['src/app/desk/items/[id]/page.tsx', 'src/components/DeskItemPanel.tsx', 'src/components/CredentialReviewPanel.tsx'] },
  { id: '31-login', title: '登入頁', phase: 4, layout: '登入', role: 'anonymous', route: '/login', sources: ['src/app/login/page.tsx', 'src/components/LoginForm.tsx'] },
  { id: '32-onboarding', title: '登入後選身分（第一次登入）', phase: 4, layout: '登入', role: 'anonymous', route: '/login?notice=no-identity', sources: ['src/components/OnboardingForm.tsx'] },
  {
    id: '33-master-lease-detail',
    title: '合約詳情（包租，執業人員兼甲方）',
    phase: 2,
    layout: '詳情',
    role: 'practice',
    route: '/contracts/{masterLease}',
    sources: ['src/app/contracts/[id]/page.tsx', 'src/components/PractitionerAssignmentPanel.tsx'],
  },
  {
    id: '34-master-lease-wizard-fields',
    title: '建約精靈 包租 步驟四（附件與簽署序列）',
    phase: 2,
    layout: '精靈',
    role: 'practice',
    route: '/contracts/{masterLeaseDraft}/edit',
    sources: ['src/app/contracts/[id]/edit/page.tsx', ...WIZARD, 'src/components/PractitionerAssignmentPanel.tsx'],
  },
  { id: '35-design', title: '設計樣式頁（內部工具）', phase: 1, layout: '總覽', role: 'owner', route: '/design', sources: ['src/app/design/page.tsx', 'src/components/DesignShowcase.tsx'] },
  { id: '36-mgmt-wizard-3-signature', title: '建約精靈 委託管理 步驟三 簽署區', phase: 2, layout: '精靈', role: 'owner', route: '/contracts/{mgmtDraft}/edit', sources: ['src/app/contracts/[id]/edit/page.tsx', 'src/components/contract-wizard/management', ...WIZARD] },
  { id: '37-mgmt-wizard-2-fields', title: '建約精靈 委託管理 步驟二 填欄位與委託標的', phase: 2, layout: '精靈', role: 'owner', route: '/contracts/{mgmtDraft}/edit', sources: ['src/app/contracts/[id]/edit/page.tsx', 'src/components/contract-wizard/management', ...WIZARD] },
];

/** 共用的殼層與跨頁元件，另列一行。 */
export const SHARED_SOURCES = [
  'src/components/AppShell.tsx',
  'src/components/OwnerShell.tsx',
  'src/components/OwnerShell.module.css',
  'src/components/AccountBar.tsx',
  'src/components/IdentitySwitcher.tsx',
  'src/components/DisplayCode.tsx',
  'src/components/AppConfigProvider.tsx',
  'src/app/layout.tsx',
  'src/app/owner/layout.tsx',
  'src/app/globals.css',
];

/** 承租人端不在重構範圍，只為了驗收 MIL-121 而截圖。 */
export const TENANT_PAGES = [
  { id: 't1-tenant-list', title: '承租人端 我的案件', route: '/tenant' },
  { id: 't2-tenant-case', title: '承租人端 案件詳情', route: '/tenant/cases/{tenantCase}' },
];

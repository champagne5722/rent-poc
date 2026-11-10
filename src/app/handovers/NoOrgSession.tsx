import NoAccess from '@/components/page/NoAccess';

/** 後台沒有組織身分時的畫面。C 線接上登入前，用環境變數 PRACTICE_ORG_SESSION_ORG_ID=none 模擬。 */
export default function NoOrgSession({ title = '移交列表' }: { title?: string }) {
  return <NoAccess title={title} description="目前的帳號不屬於任何執業主體，沒有移交案件。請用執業主體的身分登入。" />;
}

'use client';

import { Empty } from 'antd';

/** 後台沒有組織身分時的空狀態。C 線接上登入前，用環境變數 PRACTICE_ORG_SESSION_ORG_ID=none 模擬。 */
export default function NoOrgSession() {
  return <Empty description="目前的帳號不屬於任何執業主體，沒有移交案件。" />;
}

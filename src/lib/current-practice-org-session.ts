import { connection } from 'next/server';
import { resolvePracticeOrgSession, type PracticeOrgSession } from './practice-org-session';

/**
 * 目前請求的執業主體組織身分，不屬於任何執業主體時回傳 null。只給 server component 與 route 用。
 * C 線接上登入後只換這個函式的實作，呼叫端不動（比照 currentOwnerSession）。
 */
export async function currentPracticeOrgSession(): Promise<PracticeOrgSession | null> {
  // 環境變數要在請求時讀，不得在 build 時凍結
  await connection();
  return resolvePracticeOrgSession(process.env);
}

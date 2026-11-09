import type { OrgTx } from '../pg/with-tx';

// 站內通知的讀取與已讀（MIL-120）。看得到的通知＝收件成員為空（整個組織），或收件成員是自己。
// 組織隔離靠 RLS，這裡不另外過濾 org_id。已讀狀態整列共用。

export interface NotificationView {
  id: string;
  kind: string;
  title: string;
  body: string;
  linkPath: string | null;
  createdAt: Date;
  read: boolean;
}

interface Row {
  id: string;
  kind: string;
  title: string;
  body: string;
  link_path: string | null;
  created_at: Date;
  read_at: Date | null;
}

const VISIBLE = '(recipient_party_id IS NULL OR recipient_party_id = $1)';
const MAX_LIST = 200;

/** 新的在前。limit 預設 50，上限 200。 */
export async function listNotifications(
  tx: OrgTx,
  partyId: string,
  options: { unreadOnly?: boolean; limit?: number } = {},
): Promise<NotificationView[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), MAX_LIST);
  const { rows } = await tx.query<Row>(
    `SELECT id, kind, title, body, link_path, created_at, read_at FROM org.notifications
      WHERE ${VISIBLE} AND ($2::boolean IS NOT TRUE OR read_at IS NULL)
      ORDER BY id DESC LIMIT $3`,
    [partyId, options.unreadOnly === true, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    linkPath: r.link_path,
    createdAt: r.created_at,
    read: r.read_at !== null,
  }));
}

export async function countUnread(tx: OrgTx, partyId: string): Promise<number> {
  const { rows } = await tx.query<{ n: string }>(
    `SELECT count(*) AS n FROM org.notifications WHERE ${VISIBLE} AND read_at IS NULL`,
    [partyId],
  );
  return Number(rows[0].n);
}

/**
 * 標已讀。看不到的通知（別的組織、別人的個人通知、不存在）回 false，不改資料。
 * 已經是已讀的通知再標一次回 true，已讀時間不變。
 */
export async function markRead(tx: OrgTx, id: string, partyId: string): Promise<boolean> {
  const visible = await tx.query(`SELECT 1 FROM org.notifications WHERE id = $2 AND ${VISIBLE}`, [partyId, id]);
  if (visible.rows.length === 0) return false;
  await tx.query(
    `UPDATE org.notifications SET read_at = now(), read_by_party_id = $1 WHERE id = $2 AND read_at IS NULL`,
    [partyId, id],
  );
  return true;
}

/** 把自己看得到的未讀全部標已讀，回傳標了幾則。 */
export async function markAllRead(tx: OrgTx, partyId: string): Promise<number> {
  const { rows } = await tx.query(
    `UPDATE org.notifications SET read_at = now(), read_by_party_id = $1 WHERE ${VISIBLE} AND read_at IS NULL RETURNING id`,
    [partyId],
  );
  return rows.length;
}

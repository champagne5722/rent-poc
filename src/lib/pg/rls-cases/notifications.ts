// 站內通知與通知 email（MIL-120）。
import { newUlid } from '../ulid';
import type { OrgTableCase, RlsRegistration } from './types';

const orgTables: Record<string, OrgTableCase> = {
  // 站內通知與通知 email（MIL-120）。業務鍵固定：兩個組織各寫一列都要成功。
  // email 列掛在同組織的通知上（複合外鍵），所以 seed 一併建立父列。
  'org.notifications': {
    async seed(tx, orgId) {
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.notifications (id, org_id, kind, title, body) VALUES ($1, $2, 'penetration.test', '滲透測試通知', '內文')`,
        [id, orgId],
      );
      return id;
    },
  },
  'org.notification_emails': {
    async seed(tx, orgId) {
      const notificationId = newUlid();
      await tx.query(
        `INSERT INTO org.notifications (id, org_id, kind, title, body) VALUES ($1, $2, 'penetration.test', '滲透測試通知', '內文')`,
        [notificationId, orgId],
      );
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.notification_emails (id, org_id, notification_id, kind, to_email, from_name, subject, body_text)
         VALUES ($1, $2, $3, 'penetration.test', 'penetration@example.com', '滲透測試', '主旨', '本文')`,
        [id, orgId, notificationId],
      );
      return id;
    },
  },
};

export const notificationsRls: RlsRegistration = { orgTables };

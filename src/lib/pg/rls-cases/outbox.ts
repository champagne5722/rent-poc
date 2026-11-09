// 外送動作佇列（org.outbox）。
import { newUlid } from '../ulid';
import type { OrgTableCase, RlsRegistration } from './types';

const orgTables: Record<string, OrgTableCase> = {
  'org.outbox': {
    async seed(tx, orgId) {
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.outbox (id, org_id, action, subject_type, subject_id, status)
         VALUES ($1, $2, 'void_sign_task', 'contract', $3, 'pending')`,
        [id, orgId, newUlid()],
      );
      return id;
    },
  },
};

export const outboxRls: RlsRegistration = { orgTables };

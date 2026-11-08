import { withTx } from '../pg/database';
import type { RequestContext } from '../request-context';

// 殼層右上角顯示的使用者名稱與目前身分。顯示用的資料，不是授權依據。

export interface WhoAmI {
  displayName: string;
  kind: RequestContext['kind'];
  /** 組織身分才有。 */
  orgName: string | null;
}

export async function whoAmI(rc: RequestContext): Promise<WhoAmI> {
  return withTx({ kind: 'control' }, async (tx) => {
    const party = await tx.query<{ display_name: string }>('SELECT display_name FROM control.parties WHERE id = $1', [rc.partyId]);
    let orgName: string | null = null;
    if (rc.kind === 'org') {
      const org = await tx.query<{ name: string }>('SELECT name FROM control.orgs WHERE id = $1', [rc.orgId]);
      orgName = org.rows[0]?.name ?? null;
    }
    return { displayName: party.rows[0]?.display_name ?? '', kind: rc.kind, orgName };
  });
}

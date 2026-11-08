import { appendAudit } from '../audit';
import { listIdentityOptions, type IdentityFacts, defaultIdentityFacts } from '../auth/account-service';
import { loadLiveSession } from '../auth/login-flow';
import { withTx } from '../pg/database';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import type { SessionRow } from '../auth/session-service';
import type { FormField } from './onboarding-rules';
import { validateOwnerForm, validatePracticeForm } from './onboarding-rules';

// 第一次登入建組織（MIL-106，ADR-0022 決議 4）。帳號還沒有任何身分時，選「我是屋主」或「我是經理人」。
//
// 一個交易做完：建組織、第一位 admin、（經理人）登錄執業主體或排審核台、把 session 的身分切到新組織、寫稽核事件。
// 交易開在新組織的 org 脈絡，control 的表不掛 RLS 所以同一個交易寫得進去，稽核事件進新組織自己的鏈。

export interface OnboardingDeps {
  now: Date;
  facts?: IdentityFacts;
}

export type OnboardingResult =
  | { status: 'ok'; landing: string }
  | { status: 'unauthenticated' }
  /** 帳號已經有身分，不能再用這條路建組織。 */
  | { status: 'has_identity' }
  | { status: 'invalid'; field: FormField; message: string; code?: 'company_required' };

class IdentityTaken extends Error {}

async function requireNoIdentity(token: string | undefined, deps: OnboardingDeps): Promise<SessionRow | 'unauthenticated' | 'has_identity'> {
  const session = await loadLiveSession(token, deps.now);
  if (!session) return 'unauthenticated';
  if (session.identity) return 'has_identity';
  const options = await withTx({ kind: 'control' }, (tx) => listIdentityOptions(tx, session, deps.facts ?? defaultIdentityFacts));
  return options.length > 0 ? 'has_identity' : session;
}

/** 建 control.orgs 與第一位 admin，把 session 切到新組織，寫 org.create 與 member.grant。 */
async function createOrgAndAdmin(tx: OrgTx, session: SessionRow, input: { orgId: string; name: string; kind: 'owner' | 'practice'; now: Date }) {
  const at = input.now.toISOString();
  await tx.query('INSERT INTO control.orgs (id, name, kind, created_at) VALUES ($1, $2, $3, $4)', [input.orgId, input.name, input.kind, at]);
  const membershipId = newUlid();
  await tx.query(
    `INSERT INTO control.org_memberships (id, org_id, user_id, role, created_at) VALUES ($1, $2, $3, 'admin', $4)`,
    [membershipId, input.orgId, session.userId, at],
  );
  // 只切還是空身分的 session：兩個請求同時建組織時，第二個回滾，不會建出兩個組織
  const switched = await tx.query(
    `UPDATE control.sessions SET identity_kind = 'org', identity_org_id = $2 WHERE id = $1 AND identity_kind IS NULL RETURNING id`,
    [session.sessionId, input.orgId],
  );
  if (switched.rows.length === 0) throw new IdentityTaken();
  await appendAudit(tx, { action: 'org.create', object: { type: 'org', id: input.orgId }, payload: { kind: input.kind } });
  await appendAudit(tx, { action: 'member.grant', object: { type: 'membership', id: membershipId }, payload: { role: 'admin', via: 'org_create' } });
}

export async function createOwnerOrg(token: string | undefined, rawForm: { name?: unknown }, deps: OnboardingDeps): Promise<OnboardingResult> {
  const gate = await requireNoIdentity(token, deps);
  if (typeof gate === 'string') return { status: gate };
  const form = validateOwnerForm(rawForm);
  if (!form.ok) return { status: 'invalid', field: form.field, message: form.message };

  const orgId = newUlid();
  try {
    await withTx({ kind: 'org', orgId, partyId: gate.partyId }, (tx) =>
      createOrgAndAdmin(tx, gate, { orgId, name: form.value.name, kind: 'owner', now: deps.now }),
    );
  } catch (error) {
    if (error instanceof IdentityTaken) return { status: 'has_identity' };
    throw error;
  }
  return { status: 'ok', landing: '/owner' };
}

/**
 * 經理人登錄。統編沒人登錄時建執業主體與待驗證的業別；已被別的組織登錄時，不建新列，排一筆審核台項目。
 * 兩種情況的回傳值與稽核事件完全相同，呼叫端與畫面都不得區分（不透露別的組織是否存在）。
 */
export async function createPracticeOrg(token: string | undefined, rawForm: Record<string, unknown>, deps: OnboardingDeps): Promise<OnboardingResult> {
  const gate = await requireNoIdentity(token, deps);
  if (typeof gate === 'string') return { status: gate };
  const form = validatePracticeForm(rawForm);
  if (!form.ok) return { status: 'invalid', field: form.field, message: form.message, code: form.code };
  const { name, taxId, entityType, kinds } = form.value;

  const orgId = newUlid();
  try {
    await withTx({ kind: 'org', orgId, partyId: gate.partyId }, async (tx) => {
      await createOrgAndAdmin(tx, gate, { orgId, name, kind: 'practice', now: deps.now });
      await tx.query(
        'SELECT registry.claim_practice_entity($1, $2, $3, $4, $5, $6, $7, $8)',
        [
          orgId,
          taxId,
          name,
          entityType,
          kinds,
          newUlid(),
          kinds.map(() => newUlid()),
          // 每個業別一筆 license 項目，另加一筆備用給 entity_claim（函式只用到其中需要的）
          Array.from({ length: kinds.length + 1 }, () => newUlid()),
        ],
      );
      // 不論統編是第一次登錄還是已被別的組織登錄，事件都一樣：稽核匯出不得讓認領方推出別的組織存在（ADR-0012 決議 8）。
      // 資料只有認領方自己填的欄位
      await appendAudit(tx, {
        action: 'practice_entity.register',
        object: { type: 'org', id: orgId },
        payload: { tax_id: taxId, entity_type: entityType, kinds },
      });
    });
  } catch (error) {
    if (error instanceof IdentityTaken) return { status: 'has_identity' };
    throw error;
  }
  return { status: 'ok', landing: '/' };
}

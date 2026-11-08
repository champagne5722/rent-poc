// decideAccess：權限判斷的純函式（ADR-0023 決議 6、7）。
// 沒有 I/O，不碰時鐘。事實由 authorize() 載入，見同目錄 README.md。

import {
  ACTIONS,
  TERMINAL_CASE_STATES,
  type ActionId,
  type CaseActionRule,
  type CaseVariant,
  type OrgActionRule,
} from './actions';
import type { AccessDecision, AccessDenyReason, AccessFacts, CaseAccessFacts, OnBehalfFacts } from './facts';

const deny = (reason: AccessDenyReason): AccessDecision => ({ allowed: false, reason });

/**
 * 判斷目前身分能不能對案件（或組織）執行動作。
 *
 * 檢查順序：動作存在 → 是成員 → 動作授予這個成員 → viewer 寫入 → 組織角色 → 案件狀態 → 代操作條件。
 * 主辦組織與案件成員是兩條路徑，任一條通過就允許。都不通過時回傳第一條路徑的原因。
 */
export function decideAccess(facts: AccessFacts, action: ActionId): AccessDecision {
  if (!Object.hasOwn(ACTIONS, action)) return deny('unknown_action');
  const rule = ACTIONS[action];
  return rule.scope === 'org' ? decideOrgAction(facts, rule) : decideCaseAction(facts, rule);
}

function decideOrgAction(facts: AccessFacts, rule: OrgActionRule): AccessDecision {
  if (facts.orgRole === null) return deny('no_org_context');
  if (rule.effect === 'write' && facts.orgRole === 'viewer') return deny('viewer_read_only');
  if (!rule.orgRoles.includes(facts.orgRole)) return deny('role_not_allowed');
  return { allowed: true, via: 'org_role', onBehalf: false };
}

function variantOf(c: CaseAccessFacts): CaseVariant {
  return c.kind === 'lease' ? c.businessType : 'management';
}

function decideCaseAction(facts: AccessFacts, rule: CaseActionRule): AccessDecision {
  const c = facts.caseFacts;
  if (c === null) return deny('no_case');
  if (!c.isHostOrgMember && c.relations.length === 0) return deny('not_a_member');

  const variant = variantOf(c);
  const paths: ('host_org' | 'case_relation')[] = [];
  if (c.isHostOrgMember && rule.hostRoles[variant] !== undefined) paths.push('host_org');
  const grantedRelations = rule.relations[variant] ?? [];
  if (c.relations.some((r) => grantedRelations.includes(r))) paths.push('case_relation');
  if (paths.length === 0) return deny('not_granted');

  let firstDenial: AccessDecision | null = null;
  for (const via of paths) {
    const decision = checkPath(facts, c, rule, variant, via);
    if (decision.allowed) return decision;
    firstDenial ??= decision;
  }
  return firstDenial as AccessDecision;
}

function checkPath(
  facts: AccessFacts,
  c: CaseAccessFacts,
  rule: CaseActionRule,
  variant: CaseVariant,
  via: 'host_org' | 'case_relation',
): AccessDecision {
  if (rule.effect === 'write' && facts.orgRole === 'viewer') return deny('viewer_read_only');

  if (via === 'host_org') {
    const roles = rule.hostRoles[variant] ?? [];
    if (facts.orgRole === null || !roles.includes(facts.orgRole)) return deny('role_not_allowed');
  }

  if (rule.effect === 'write' && TERMINAL_CASE_STATES.includes(c.state)) return deny('case_closed_read_only');
  if (!rule.states.includes(c.state)) return deny('state_not_allowed');

  const isOnBehalf = via === 'host_org' && variant === 'managed' && rule.onBehalfScope !== null;
  if (isOnBehalf && c.kind === 'lease') {
    const failure = checkOnBehalf(c.onBehalf, rule.onBehalfScope);
    if (failure !== null) return deny(failure);
  }
  return { allowed: true, via, onBehalf: isOnBehalf };
}

/** 代操作四個條件（ADR-0023 決議 7）。依條件 1、2、3、4 的順序回傳第一個不成立的原因。 */
function checkOnBehalf(
  facts: OnBehalfFacts | null,
  scope: NonNullable<CaseActionRule['onBehalfScope']>,
): AccessDenyReason | null {
  if (facts === null) return 'no_mandate_link';
  if (!facts.mandateCaseActive) return 'mandate_not_active';
  if (!facts.rentalUnitInMandate) return 'unit_not_in_mandate';
  if (!facts.mandateScopes.includes(scope)) return 'scope_not_covered';
  if (!facts.practiceEntityVerified) return 'practice_not_verified';
  if (!facts.hasSignableManager) return 'no_signable_manager';
  return null;
}

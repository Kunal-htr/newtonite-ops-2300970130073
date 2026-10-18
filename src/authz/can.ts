import { getTransitionRule } from '../items/workflow';
import type { ItemStatus } from '../items/workflow';

/**
 * The ONLY permission check (SYSTEM_DESIGN.md "authz/can.ts"). Pure and
 * synchronous: no database access, no side effects. It receives the already
 * loaded memberships (requireAuth loads them on every request) and the item
 * context it needs, and returns an allow/deny result.
 *
 * Workflow rules themselves live in items/workflow.ts - can() only enforces
 * them together with the permission matrix.
 *
 * State preconditions (e.g. "item must be unassigned and OPEN/IN_PROGRESS to
 * claim") are NOT permissions; they are enforced by the SQL in the service
 * layer and surface as 409 Conflicts.
 */

export type Role = 'viewer' | 'member' | 'lead' | 'admin';

export interface UserMembership {
  teamId: string;
  role: Role;
}

export interface CanUser {
  id: string;
  memberships: UserMembership[];
}

export type Action =
  | 'read'
  | 'create'
  | 'edit'
  | 'comment'
  | 'claim'
  | 'transition'
  | 'approve'
  | 'reject'
  | 'close'
  | 'reassign';

export interface CanItem {
  /** The team the action targets. Every action needs at least this. */
  teamId: string;
  assigneeId?: string | null;
  /** Current status - required for action 'transition'. */
  status?: ItemStatus;
  /** Target status - required for action 'transition'. */
  targetStatus?: ItemStatus;
}

export type DenyReason = 'not_in_team' | 'insufficient_role' | 'own_item';

export type CanResult = { allowed: true } | { allowed: false; reason: DenyReason };

// Permission matrix rows (docs/SYSTEM_DESIGN.md "Permission Matrix"):
const WRITE_ROLES: readonly Role[] = ['member', 'lead', 'admin']; // create, comment, edit, claim
const REASSIGN_ROLES: readonly Role[] = ['lead', 'admin']; // reassign

/** approve/reject/close are fixed transitions; 'transition' takes from/to from the item. */
const FIXED_TRANSITIONS: Partial<Record<Action, { from: ItemStatus; to: ItemStatus }>> = {
  approve: { from: 'AWAITING_APPROVAL', to: 'RESOLVED' },
  reject: { from: 'AWAITING_APPROVAL', to: 'IN_PROGRESS' },
  close: { from: 'RESOLVED', to: 'CLOSED' },
};

export function can(user: CanUser, action: Action, item?: CanItem): CanResult {
  if (!item) return { allowed: false, reason: 'not_in_team' };

  // One membership per (user, team); the role in the item's team decides.
  const membership = user.memberships.find((m) => m.teamId === item.teamId);
  if (!membership) return { allowed: false, reason: 'not_in_team' };

  // Read: any role in the team, including viewer.
  if (action === 'read') return { allowed: true };

  if (action === 'create' || action === 'edit' || action === 'comment' || action === 'claim') {
    return WRITE_ROLES.includes(membership.role)
      ? { allowed: true }
      : { allowed: false, reason: 'insufficient_role' };
  }

  if (action === 'reassign') {
    return REASSIGN_ROLES.includes(membership.role)
      ? { allowed: true }
      : { allowed: false, reason: 'insufficient_role' };
  }

  // Remaining actions are transitions: 'transition' (from item.status to item.targetStatus)
  // plus the fixed aliases approve/reject/close.
  const fixed = FIXED_TRANSITIONS[action];
  const from = fixed ? fixed.from : item.status;
  const to = fixed ? fixed.to : item.targetStatus;

  // A transition with no rule does not exist; services must reject it as 422 via
  // workflow.getTransitionRule BEFORE calling can(). Defensively: nobody is allowed.
  if (!from || !to) return { allowed: false, reason: 'insufficient_role' };
  const rule = getTransitionRule(from, to);
  if (!rule) return { allowed: false, reason: 'insufficient_role' };

  if (!rule.roles.includes(membership.role)) {
    return { allowed: false, reason: 'insufficient_role' };
  }
  if (rule.assigneeOnlyForMember && membership.role === 'member' && item.assigneeId !== user.id) {
    return { allowed: false, reason: 'insufficient_role' };
  }
  if (rule.forbidSelf && item.assigneeId === user.id) {
    return { allowed: false, reason: 'own_item' };
  }

  return { allowed: true };
}

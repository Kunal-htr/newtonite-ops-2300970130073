import type { Role } from '../authz/can';

/**
 * Workflow map (SYSTEM_DESIGN.md "workflow.ts"): the single owner of which
 * transitions exist and what role each requires. Pure data + lookup only -
 * role enforcement lives in can(); nothing else encodes workflow rules.
 *
 *   OPEN -> IN_PROGRESS -> AWAITING_APPROVAL -> RESOLVED -> CLOSED
 *                                | (reject)
 *                            IN_PROGRESS
 */

export type ItemStatus = 'OPEN' | 'IN_PROGRESS' | 'AWAITING_APPROVAL' | 'RESOLVED' | 'CLOSED';

export interface TransitionRule {
  from: ItemStatus;
  to: ItemStatus;
  /** Team roles allowed to perform the transition. */
  roles: readonly Role[];
  /** When the actor's team role is 'member', the actor must be the item's assignee. */
  assigneeOnlyForMember: boolean;
  /** When true, the actor must not be the item's assignee (separation of duties). */
  forbidSelf: boolean;
}

export const TRANSITIONS: readonly TransitionRule[] = [
  // Claim moves OPEN -> IN_PROGRESS automatically; the same transition is also
  // reachable via /transition. Members may only act on items assigned to them.
  {
    from: 'OPEN',
    to: 'IN_PROGRESS',
    roles: ['member', 'lead', 'admin'],
    assigneeOnlyForMember: true,
    forbidSelf: false,
  },
  // Assumption C: only the assignee or a Lead (matrix: also Admin) may move to AWAITING_APPROVAL.
  {
    from: 'IN_PROGRESS',
    to: 'AWAITING_APPROVAL',
    roles: ['member', 'lead', 'admin'],
    assigneeOnlyForMember: true,
    forbidSelf: false,
  },
  // Approve: Lead only, and never their own item (Assumption D).
  {
    from: 'AWAITING_APPROVAL',
    to: 'RESOLVED',
    roles: ['lead'],
    assigneeOnlyForMember: false,
    forbidSelf: true,
  },
  // Reject: back to IN_PROGRESS, same rule as approve.
  {
    from: 'AWAITING_APPROVAL',
    to: 'IN_PROGRESS',
    roles: ['lead'],
    assigneeOnlyForMember: false,
    forbidSelf: true,
  },
  // "Resolve to CLOSED": Lead or Admin. CLOSED is terminal.
  {
    from: 'RESOLVED',
    to: 'CLOSED',
    roles: ['lead', 'admin'],
    assigneeOnlyForMember: false,
    forbidSelf: false,
  },
];

export function getTransitionRule(from: ItemStatus, to: ItemStatus): TransitionRule | undefined {
  return TRANSITIONS.find((rule) => rule.from === from && rule.to === to);
}

/**
 * All rules defined for a status - the "what can happen next" view used by
 * allowedActions and the UI. Lookup only; role enforcement stays in can().
 */
export function getAllowedTransitions(fromStatus: ItemStatus): TransitionRule[] {
  return TRANSITIONS.filter((rule) => rule.from === fromStatus);
}

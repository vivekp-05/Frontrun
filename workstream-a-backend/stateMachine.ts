/**
 * Workstream A — the lifecycle state machine guard.
 *
 * Single source of legality: `LEAD_TRANSITIONS` in shared/types.ts. Backend (A)
 * is the only place that mutates `Lead.status`, and every mutation goes through
 * `assertTransition`, so an illegal jump (e.g. DETECTED → BOOKED) can never be
 * persisted no matter who calls the API.
 */
import { LeadStatus, LEAD_TRANSITIONS } from "../shared/types";

/** Thrown when a caller asks for a transition the state machine forbids. */
export class IllegalTransitionError extends Error {
  readonly from: LeadStatus;
  readonly to: LeadStatus;
  readonly allowed: LeadStatus[];
  constructor(from: LeadStatus, to: LeadStatus) {
    const allowed = LEAD_TRANSITIONS[from] ?? [];
    super(
      `Illegal transition ${from} → ${to}. Allowed from ${from}: ${allowed.length ? allowed.join(", ") : "(terminal)"}.`
    );
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
    this.allowed = allowed;
  }
}

/** The states reachable in one step from `from`. */
export function nextStates(from: LeadStatus): LeadStatus[] {
  return LEAD_TRANSITIONS[from] ?? [];
}

/** True if `from → to` is a legal single step. */
export function canTransition(from: LeadStatus, to: LeadStatus): boolean {
  return nextStates(from).includes(to);
}

/** A terminal state has no outgoing transitions (BOOKED, LOST). */
export function isTerminal(status: LeadStatus): boolean {
  return nextStates(status).length === 0;
}

/** Throw unless `from → to` is legal. Returns `to` for convenient chaining. */
export function assertTransition(from: LeadStatus, to: LeadStatus): LeadStatus {
  if (from === to) return to; // idempotent no-op (e.g. re-delivering DELIVERED)
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return to;
}

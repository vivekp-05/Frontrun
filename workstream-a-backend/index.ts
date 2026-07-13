/**
 * Workstream A — public surface. B / C / D import from here (or hit the HTTP
 * API in server.ts). Nothing outside these exports is part of A's contract.
 */
export { store, createStore, InMemoryStore, InsforgeStore } from "./store";
export { createAnalytics, LeadAnalytics, computeFunnel } from "./analytics";
export {
  assertTransition,
  canTransition,
  nextStates,
  isTerminal,
  IllegalTransitionError,
} from "./stateMachine";
export { SEED_LEADS, REAL_SEED, DEMO_SEED, seedInto } from "./seed";

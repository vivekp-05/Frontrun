/**
 * Frontrun — HydraDB memory adapter · public surface.
 *
 * Import from here. Every write/read function is FAIL-SOFT: it never throws into
 * the caller and no-ops when HYDRA_DB_API_KEY is unset, so the three integration
 * hooks (see MEMORY_INTEGRATION.md) are safe to drop in without try/catch.
 *
 *   import * as memory from "../../lib/memory"
 *   await memory.recordDetection(lead)          // on detection
 *   const ctx = await memory.recallContext(lead) // before drafting
 *   await memory.recordOutcome(lead, reply, cls) // on reply + verdict
 */
export { readMemoryConfig, type MemoryConfig } from "./config"
export {
  createMemoryClient,
  memoryClient,
  type MemoryClient,
  type MemoryClientDeps,
  type IngestRequest,
  type QueryRequest,
  type RetrievalResult,
} from "./client"
export {
  recordDetection,
  buildDetectionIngest,
  type MemoryWriteResult,
  type RecordDetectionOptions,
} from "./graph"
export {
  recallContext,
  buildRecallQuery,
  parseRecall,
  type RecalledContext,
  type MemoryTriplet,
  type RecallOptions,
} from "./recall"
export {
  recordOutcome,
  buildOutcomeIngest,
  type OutcomeReply,
  type RecordOutcomeOptions,
} from "./outcomes"

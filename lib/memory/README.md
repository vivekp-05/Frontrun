# `/lib/memory` — HydraDB agent-memory adapter

Additive memory + relationship-graph layer for Frontrun, on `@hydradb/sdk`.
See [`../../MEMORY_INTEGRATION.md`](../../MEMORY_INTEGRATION.md) for the three
one-line hooks B/D drop in at integration.

## Modules

| File | Role |
|------|------|
| `config.ts` | env → `MemoryConfig` (`enabled` false without a key) |
| `client.ts` | lazy singleton `MemoryClient`; real SDK **or** no-op stub; injectable `fetch` |
| `graph.ts` | `recordDetection` — company/founder/round memory + graph edges |
| `recall.ts` | `recallContext` — prior memories + graph triplets before drafting |
| `outcomes.ts` | `recordOutcome` — reply interaction + `REPLIED_<VERDICT>` edge |
| `util.ts` | shared coercion / fail-soft helpers |
| `index.ts` | public barrel — import from here |

## Design

- **Fail-soft, zero-config.** No key → no-op; any error → a result object, never a
  throw. Mirrors `store.ts` (in-memory ↔ InsForge flip).
- **Pure builders.** Request construction is separated from I/O and unit-tested
  without a network (`buildDetectionIngest`, `buildRecallQuery`, `parseRecall`,
  `buildOutcomeIngest`).
- **No live calls in build/test.** Tests use a spy client + a mock `fetch`; the
  only live path is `scripts/hydra-smoke.ts`.

## Test

```bash
npx tsx lib/memory/memory.test.ts   # offline, no key required
```

## Smoke (live, manual)

```bash
HYDRA_DB_API_KEY=sk_... npx tsx scripts/hydra-smoke.ts
```

# HydraDB Memory Layer — Integration Hooks

Agent memory + relationship graph for Frontrun, via [`@hydradb/sdk`](https://docs.hydradb.com).
**Additive only.** All logic lives in [`/lib/memory`](./lib/memory). Nothing is wired
into the pipeline or webhooks yet — this doc is the drop-in guide for B and D.

## Guarantees (read before wiring)

- **Fail-soft.** Every exported function catches its own errors and returns a
  result object — it never throws into your code. A HydraDB outage cannot break
  detect / draft / reply.
- **Zero-config safe.** With no `HYDRA_DB_API_KEY`, the adapter is a no-op:
  writes return `{ written: false, skipped: true }`, recall returns an empty
  `RecalledContext`. Safe to merge before the key exists.
- **No network in build/test.** The only live call is the manual smoke script.

## Setup

```bash
# already added to root package.json:
#   "@hydradb/sdk": "^2"
```

Env (see `.env.example`):

```
HYDRA_DB_API_KEY=        # required to enable; unset = no-op
HYDRA_DB_DATABASE=frontrun   # optional (default: frontrun)
HYDRA_DB_COLLECTION=global   # optional (default: global)
HYDRA_DB_BASE_URL=           # optional; SDK default environment when unset
```

## The three one-line hooks

Import once per file:

```ts
import * as memory from "../../lib/memory" // adjust depth to the file
```

### 1 · On detection — write company/founder/round to the graph
`workstream-b-pipeline/rocketride.ts`, just after `steps.push("detected")` (~L51):

```ts
await memory.recordDetection(current) // fail-soft; no await-guard needed
```

### 2 · Before drafting — recall prior context + relationships
`workstream-b-pipeline/rocketride.ts`, just before `const drafted = draftOutreach(current)` (~L85):

```ts
const recalled = await memory.recallContext(current)
// recalled.memories: string[]   recalled.triplets: {source,predicate,target}[]
// Pass into the drafter when ready (additive; no draft signature change required first cut).
```

### 3 · On reply + verdict — write the interaction back
`workstream-d-outreach/webhooks.ts`, inside `onInboundReply`, after `replaceReply(...)` (~L207):

```ts
await memory.recordOutcome(lead, rawReply, classification)
```

## API surface (`/lib/memory`)

| Function | Returns | When |
|----------|---------|------|
| `recordDetection(lead, opts?)` | `MemoryWriteResult` | on `DETECTED` |
| `recallContext(lead, opts?)` | `RecalledContext` | before drafting |
| `recordOutcome(lead, reply, classification, opts?)` | `MemoryWriteResult` | on reply verdict |

`opts` accepts `{ client?, config? }` for injection in tests. All builders
(`buildDetectionIngest`, `buildRecallQuery`, `parseRecall`, `buildOutcomeIngest`)
are exported as pure functions.

## HydraDB mapping

- **database (tenant)** = `frontrun` — hard isolation boundary.
- **collection (sub-tenant)** = `global` (or per-SDR-seat) — recall scope.
- **memory** (`type:"memory"`): the detection/outcome text, upserted by a stable
  `id` (`detection:<leadId>`, `outcome:<leadId>:<replyId>`).
- **graph**: explicit edges via the `graphPayload` field on `context.ingest`
  (company `COMPANY`, founders `PERSON`, round `FUNDING_ROUND`; edges `FOUNDED`,
  `RAISED`, `REPLIED_<VERDICT>`). Investor nodes are not in the Form D signal
  yet — add when enrichment resolves them.
- **recall** uses the unified `query` with `type:"all"`, `mode:"thinking"`,
  `graphContext:true`.

## Verify it against the real API

```bash
HYDRA_DB_API_KEY=sk_... npx tsx scripts/hydra-smoke.ts
```

Proves ingest → recall → graphContext end to end. Requires a real key; makes
live calls (the only place that does).

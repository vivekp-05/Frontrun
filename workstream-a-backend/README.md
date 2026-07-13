# Workstream A — Backend + Data

**Branch:** `workstream-a-backend` · **Owns:** the Lead contract, persistence, InsForge + Hydra prizes.

## Your job (PRD §12A)

- Stand up **InsForge** via its MCP: a `leads` table matching [`shared/types.ts`](../shared/types.ts), plus auth + storage.
- Implement the **lifecycle state machine** — enforce `LEAD_TRANSITIONS` from `types.ts`. Reject illegal jumps.
- Expose a **status API** the frontend (C) and agents (B, D) call: `upsertLead`, `getLead`, `listLeads`, `transition`.
- Wire the **Hydra analytics view**: reply rate, funnel counts, green/red ratio → `FunnelAnalytics`.

## Interfaces you implement

`StoreProvider` and `AnalyticsProvider` in `shared/types.ts`. Everyone else calls these — keep the shape stable.

## First moves

1. Confirm InsForge MCP is connected at kickoff (risk: unverified — PRD §14).
2. Create `leads` table: columns mirror the `Lead` interface (store nested objects as JSONB).
3. Seed one fake lead so C can render and B/D can transition it by hour 3.

## Definition of done — DONE ✅

- CRUD + `transition()` enforcing the state machine, callable over HTTP. ✅
- Analytics endpoint returns live funnel counts. ✅
- Leads flow `DETECTED → … → BOOKED`; illegal jumps rejected (409). ✅
- 24/24 state-machine + analytics + InsForge-mapping tests pass; root `tsc --noEmit` clean. ✅

## Run it

```bash
# from repo root once:
npm install

# from this folder:
npm run start      # status API on http://localhost:4000 (PORT to override)
npm test           # 24 state-machine + analytics + InsForge-mapping tests
npm run typecheck  # tsc against the shared contract
```

Boots on the **in-memory** store with 6 seed leads (3 real SEC + 3 demo), so C, B, and D are unblocked with zero keys. Set `INSFORGE_API_KEY` + `INSFORGE_PROJECT_URL` (see `.env.example`) and it flips to InsForge Postgres automatically — no caller changes.

## Go live on InsForge (the prize)

```bash
# 1. put your keys in the repo-root env file (loaded automatically):
cp ../.env.example ../.env.local          # then fill INSFORGE_PROJECT_URL + INSFORGE_API_KEY

# 2. create the leads table + funnel view in your InsForge project (idempotent):
npm run db:init            # add :seed to also load the 6 seed leads → npm run db:init:seed

# 3. run — server now reports  store: InsForge
npm start
```

- `INSFORGE_PROJECT_URL` = your project base (e.g. `https://<app>.<region>.insforge.app`); `INSFORGE_API_KEY` = the **project API key** (`uak_…`, server-only — never a `NEXT_PUBLIC_` var).
- The adapter talks to InsForge's raw-SQL endpoint (`POST /api/database/advance/rawsql`) with parameterized `INSERT … ON CONFLICT` upserts, so persistence is exact and idempotent. `npm run db:init` pings first and fails loudly if the URL/key is wrong.
- **Analytics:** computed in InsForge Postgres (funnel `GROUP BY`), not Hydra — research found Hydra DB is a context/vector store, not a SQL analytics DB (its only count primitive is object-count telemetry). `FunnelAnalytics` shape is unchanged either way; Hydra can mirror later without touching callers.

## Status API (what C / B / D call)

| Method | Route | Body → Returns |
|---|---|---|
| `GET`  | `/leads` | → `Lead[]` |
| `GET`  | `/leads/:id` | → `Lead` \| 404 |
| `POST` | `/leads` | `Lead` → upsert → `Lead` |
| `POST` | `/leads/:id/transition` | `{ to: LeadStatus }` → `Lead` \| **409** if illegal |
| `GET`  | `/analytics` | → `FunnelAnalytics` |
| `POST` | `/seed` · `/reset` | reseed (in-memory) |

Illegal transitions return `409` with `{ error, from, to, allowed }` so callers see exactly what was permitted. CORS is open so the Next.js dashboard (workstream C, different port) can call it directly.

## Files

```
workstream-a-backend/
├── stateMachine.ts   # transition() guard using LEAD_TRANSITIONS (source of legality)
├── store.ts          # StoreProvider: InMemoryStore (default) + InsforgeStore (raw-SQL, flips by env)
├── analytics.ts      # AnalyticsProvider: computeFunnel() + provider
├── server.ts         # zero-dep HTTP status API (the endpoint the team calls)
├── seed.ts           # 3 real SEC + 3 demo leads
├── schema.sql        # leads table (JSONB mirror of shared/types.ts::Lead) + lead_funnel view
├── initInsforge.ts   # `npm run db:init` — create schema in InsForge (ping → migrate → verify)
├── env.ts            # loads ../.env.local before the store singleton is built (zero-dep)
├── store.test.ts     # 24 tests — run with `npm test`
├── index.ts          # public exports for in-process consumers
└── package.json      # dev/start/db:init/test/typecheck scripts
```

**Contract note:** built entirely against the existing thin `shared/types.ts`. It stays the merge boundary — richness lives here in the implementation, not in the shared file.

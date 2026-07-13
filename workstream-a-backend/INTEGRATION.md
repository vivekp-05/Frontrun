# Ingestion → Backend contract (Workstream B ⇄ A)

How the ingestion pipeline (SEC EDGAR + enrichment) writes leads into the backend.
**A owns persistence, the state machine, and analytics. B produces leads and pushes them here.**

## The one rule

Write leads shaped exactly as [`shared/types.ts`](../shared/types.ts) `Lead`, **through this API** (or the exported `store`).
Do **not** write raw rows to InsForge directly — even though you have the same InsForge keys, the table stores
camelCase↔snake_case-mapped columns and the status is guarded by a state machine. Bypassing the API corrupts both.

## Minimum a detected lead needs

```ts
{
  id: "<SEC CIK>",              // stable unique id (CIK works)
  status: "DETECTED",
  isDemo: false,
  signal: {                    // FormDSignal — the real EDGAR data
    accessionNumber, companyName, relatedPersons: string[],
    address?, amountRaised?, filedAt, edgarUrl?
  },
  createdAt: "<ISO>", updatedAt: "<ISO>",   // A re-stamps these, but send them
  replies: []
}
```
Then fill `brief` / `contact` / `draft` as you enrich, and advance status via `/transition`.

## Endpoints

| Method | Route | Body → Returns |
|---|---|---|
| `POST` | `/leads` | one `Lead` → upsert → `Lead` |
| `POST` | `/leads/bulk` | `Lead[]` (or `{ leads: [] }`) → `{ upserted, skipped }` |
| `POST` | `/leads/:id/transition` | `{ to: LeadStatus }` → `Lead` \| **409** if illegal |
| `GET`  | `/leads` · `/leads/:id` · `/analytics` | read back |

Default base URL: `http://localhost:4000` (set `PORT` to change). CORS is open.

## Legal status flow (A enforces it)

```
DETECTED → ENRICHED → DRAFTED → SENT → DELIVERED → (OPENED) → REPLIED
         → GREEN | YELLOW | RED → FOLLOW_UP_DRAFTED → BOOKED   (LOST from most states)
```
An illegal jump (e.g. `DETECTED → BOOKED`) returns **409** with the allowed set — so you always know what's permitted.

## Example — push a batch, then enrich one

```bash
# 1. detected leads from EDGAR
curl -X POST localhost:4000/leads/bulk -H 'content-type: application/json' \
  -d '{"leads":[ { "id":"2144979","status":"DETECTED","isDemo":false,
        "signal":{"accessionNumber":"...","companyName":"Synthreo, Inc.",
                  "relatedPersons":["Callen Sapien (Executive Officer)"],
                  "filedAt":"2026-07-13"},
        "createdAt":"2026-07-13T00:00:00Z","updatedAt":"2026-07-13T00:00:00Z","replies":[] } ]}'

# 2. after enrichment, POST the same id with brief/contact/draft filled, then:
curl -X POST localhost:4000/leads/2144979/transition -d '{"to":"ENRICHED"}'
curl -X POST localhost:4000/leads/2144979/transition -d '{"to":"DRAFTED"}'
```

## In-process alternative

If you run in the same repo/process instead of over HTTP:
```ts
import { store } from "./workstream-a-backend";   // or "@frontrun/backend"
await store.upsertLead(lead);
await store.transition(lead.id, LeadStatus.ENRICHED);
```

## Shared InsForge note

You and A point at the **same InsForge project** (`INSFORGE_PROJECT_URL` + `INSFORGE_API_KEY` = the `ik_` project key).
A has already run `npm run db:init`, so the `leads` table exists. Your writes appear in A's store and the frontend immediately.
Analytics (funnel) are computed by A from that table — Hydra is optional (it's a context/vector store, not a SQL analytics DB).

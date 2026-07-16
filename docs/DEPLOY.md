# Frontrun — Deploy handoff (Vercel)

> Prepared by the deploy-prep session for the session that **owns the Vercel project**.
> Verified against the integrated working tree (workstream-c-frontend + A + D) on 2026-07-13.
> **Project name to use: `frontrun`** (Vercel scope `invivekpatel-5878s-projects`).

## What deploys

The only deployable surface is the Next.js 16 app in **`workstream-c-frontend/`**. It imports
the other workstreams as libraries via tsconfig path aliases + Next `externalDir`:

- `@a/store`, `@a/analytics`  → `../workstream-a-backend`
- `@d/send`, `@d/routes`      → `../workstream-d-outreach`
- `@shared/*`                 → `../shared`

Five API routes back the dashboard (all `runtime="nodejs"`, `dynamic="force-dynamic"`):

| Route | Purpose | Needs |
|---|---|---|
| `GET  /api/leads`            | live leads from InsForge (falls back to empty→sim) | InsForge |
| `GET  /api/analytics`        | funnel analytics over live leads | InsForge |
| `POST /api/outreach`         | "Run outreach": send demo DRAFTED leads via Resend | Resend |
| `POST /api/webhooks/resend`  | delivery + inbound-reply → Band triage → state machine | Resend webhook secret |
| `POST /api/webhooks/calcom`  | BOOKING_CREATED → lead BOOKED | Cal.com webhook secret |

Graceful degradation: dashboard/outreach routes return 200 with a safe fallback if their
keys are missing. **Exception: the two webhook routes fail CLOSED** — deployed with no
signing secret they return 503 for every POST (never process unverified events), so both
webhook secrets below are merge prerequisites for the live reply loop.

## Verified before handoff

- `next build` (Turbopack) — clean, all routes compile.
- `tsc --noEmit` (whole monorepo) — 0 errors.
- `npm run test:d` — 18/18 pass (Resend sig verify, Cal.com booking, inbound fetch→triage).
- A `store.test.ts` — pass.

## Vercel project settings

- **Framework preset:** Next.js (auto-detected)
- **Root Directory:** `workstream-c-frontend`
- **⚠️ "Include files outside of the root directory in the Build Step": ENABLED** — REQUIRED.
  The app imports `../shared`, `../workstream-a-backend`, `../workstream-d-outreach`. Without
  this, the build fails resolving those imports. (This is the one non-obvious monorepo setting.)
- **Install command:** default (`npm install` at repo root — npm workspaces).
- **Build command:** default (`next build`).
- **Node version:** 20.x or 22.x (both fine).
- **Production branch:** `main` (deploy production only after the A–D merge lands on `main`;
  as of prep, `origin/main` did NOT yet contain the `app/api/*` routes or the D work).

## Environment variables

Set these on the Vercel project. **Only the app's actual runtime vars are listed** — B's
enrichment keys (You.com/Nimble/Hunter/RocketRide) are NOT imported by the app; skip them.
`PORT`/`SEED_DEMO` are for A's standalone server, not the Vercel app; skip them too.

Legend: ✅ value in repo-root `.env.local` · ⚠️ needed for full loop, not yet available.

### InsForge (persistence — A store + analytics)
| Var | Status | Notes |
|---|---|---|
| `INSFORGE_PROJECT_URL` | ✅ | required for real store; unset ⇒ in-memory |
| `INSFORGE_API_KEY`     | ✅ | required for real store; unset ⇒ in-memory |
| `INSFORGE_LEADS_TABLE` | — | optional, defaults to `leads` |

### Resend (send — D)
| Var | Status | Notes |
|---|---|---|
| `RESEND_API_KEY`    | ✅ | unset ⇒ mock send |
| `RESEND_FROM_EMAIL` | ✅ | branded verified sender |
| `RESEND_REPLY_TO`   | ✅ | managed inbox where replies land |
| `RESEND_WEBHOOK_SECRET` | ⚠️ | Svix signing secret (`whsec_…`) from Resend webhook UI. **REQUIRED on the deploy**: unset ⇒ the route fails CLOSED (503, no event processed — leads freeze at SENT and Resend/Svix may auto-disable the endpoint after sustained failures). Obtainable only after the URL exists, so set it (prod AND preview) immediately after wiring the webhook. |

### Band (reply triage — D, read via `BAND_AGENT_${ROLE}_{ID,HANDLE,KEY}`)
| Var | Status | Notes |
|---|---|---|
| `BAND_AGENT_SUMMARIZER_ID` / `_HANDLE` / `_KEY` | ✅ | |
| `BAND_AGENT_CLASSIFIER_ID` / `_HANDLE` / `_KEY` | ✅ | |
| `BAND_AGENT_DRAFTER_ID` / `_HANDLE` / `_KEY`    | ✅ | |
| `BAND_API_URL`      | — | optional, code default `https://app.band.ai/api/v1` |
| `BAND_OWNER_HANDLE` | — | optional; agent handles are explicit |
| `BAND_TASKS`        | — | optional, default `0` |
| `BAND_API_KEY`      | n/a | **do NOT set** — provisioning script only, not runtime |

### Cal.com (booking — D)
| Var | Status | Notes |
|---|---|---|
| `CALCOM_LINK`           | ⚠️ | base booking URL, e.g. `https://cal.com/you/intro`. Without it, GREEN replies get no booking link. |
| `CALCOM_WEBHOOK_SECRET` | ⚠️ | HMAC secret set on the Cal.com webhook. Verifies BOOKING_CREATED. **REQUIRED on the deploy**: unset ⇒ the route fails CLOSED (503) and bookings never flip leads to BOOKED. |
| `CALCOM_API_KEY`        | n/a | **do NOT set** — not read by runtime |

### Sender identity / model / mock toggles (all optional)
| Var | Notes |
|---|---|
| `FROM_NAME`, `FROM_COMPANY` | branded sender identity in drafts; unset ⇒ code defaults |
| `TRIAGE_MODEL` | triage LLM model; unset ⇒ code default |
| `MOCK_SEND`, `MOCK_TRIAGE`, `MOCK_LLM` | **leave unset** for the real demo (set `=1` only to force mocks) |

## Post-deploy webhook wiring (needs the live URL first)

> ⚠️ Until both steps below land the secrets on Vercel, every webhook POST answers 503
> (fail closed — nothing is processed) and leads stay frozen at SENT. Do these with the
> merge, not "later": the known `frontrun` prod env has NEITHER secret set yet.

1. **Resend** → Webhooks → add endpoint `https://<deployment>/api/webhooks/resend`,
   subscribe to delivery + inbound events → copy the signing secret → set
   `RESEND_WEBHOOK_SECRET` on Vercel → redeploy.
2. **Cal.com** → Settings → Developer → Webhooks → add `https://<deployment>/api/webhooks/calcom`,
   event `BOOKING_CREATED`, set a secret → set `CALCOM_WEBHOOK_SECRET` (+ `CALCOM_LINK`) on
   Vercel → redeploy.

## ⚠️ Key-transfer blocker

The real key **values** live only in this checkout's `.env.local`, which is git-ignored — they
are **not** in the cloned repo the deploy-owner session has. The owner cannot set real env
vars until those values are transferred (via the repo owner). Options: hand over `.env.local`,
or have the checkout that holds them push env to the Vercel project.

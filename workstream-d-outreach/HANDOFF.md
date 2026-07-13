# Workstream D — Handoff & Continuation Prompt

> **You are picking up Workstream D (Outreach + Reply Loop) of Frontrun**, an
> autonomous SDR built for the "Build Your Own AI Company" hackathon. This
> document is both a status handoff and a prompt: read it top to bottom and you
> have everything needed to continue without re-deriving context.

---

## 1. What Frontrun is (one paragraph)

Frontrun is an autonomous SDR for recruiting/staffing agencies. It detects the
moment a company raises funding (SEC Form D, same-day), researches it, resolves
the right contact, drafts personalized outreach, sends it, then runs the entire
reply conversation — triage, follow-up, booking — as an AI employee. One build,
seven sponsor prize surfaces (InsForge, You.com, Nimble, RocketRide, Band, Hydra,
plus Resend/Cal.com). The team is 4 generalists split across workstreams A–D
against a shared `types.ts` contract.

## 2. Workstream D's scope

D owns the **back half of the lead lifecycle** — everything after a draft exists:

```
DRAFTED → [ SENT → DELIVERED → (OPENED) → REPLIED
           → GREEN / YELLOW / RED → FOLLOW_UP_DRAFTED → BOOKED ]
                                RED ───────────────────→ LOST
```

Deliverables: send via Resend, capture delivery/open, catch inbound replies and
triage them (green/yellow/red + drafted next step), detect Cal.com bookings, seed
the 3 controlled demo companies, and own the live demo run. **Prize ownership:
Band** (must be load-bearing in the triage step) + the reply-loop "wow."

---

## 3. Status snapshot (as of this handoff)

**D's code is functionally complete and verified end-to-end against mocks.**
`npm run test:d` is green (3 suites), `npm run typecheck` is clean.

| Piece | File | Status |
|---|---|---|
| Reply triage agent | `triage.ts` | ✅ built + tested |
| Resend send + parallel + entry point | `send.ts` | ✅ built + tested |
| Webhooks (delivery / inbound / booking) | `webhooks.ts` | ✅ built + tested |
| 3 demo companies | `seed.ts` | ✅ built |
| In-memory StoreProvider stand-in | `store.mock.ts` | ✅ built |
| Full-loop integration test | `webhooks.test.ts` | ✅ green |
| **Band orchestration wrapper** | `band.ts` | ✅ built + LIVE-verified (prize) |
| Band test suite | `band.test.ts` | ✅ green (added to `test:d`) |
| **Webhook route adapters + sig verify** | `routes.ts` / `signatures.ts` | ✅ built + tested |
| Route/signature test suite | `routes.test.ts` | ✅ green (added to `test:d`) |
| **Real integration** (A store, B drafts, Resend domain, mount routes) | — | ⏳ pending others |

`npm run test:d` is now 4 suites (triage + send + webhooks + band). Committed on
branch `workstream-d-outreach` (`c8c5891`); Band work not yet committed.

> **Band is LIVE-verified** (2026-07-13, account `in.vivekpatel`, Free tier). The
> real Agent API is baked into `band.ts` and confirmed end-to-end via `band.ts`
> itself (`band.live.ts`): a real Band room is created, the 3 registered agents
> coordinate (summarize→classify→draft), `via: "band"`.
>
> Key facts learned live (differ from the docs' first impression):
> - Base `https://app.band.ai/api/v1`; auth header **`X-API-Key`** (not Bearer);
>   responses nested under `.data`.
> - The provided key is a **human/user key** — it can't create rooms on Free
>   (Human API is Enterprise-gated, 403). So each triage specialist is a **registered
>   external agent** with its own agent key; coordination runs entirely on the
>   **Agent API**, which works on Free.
> - **Chat Tasks (Beta) 404 on Free** — the task board is opt-in (`BAND_TASKS=1`);
>   the coordination + audit trail live in the room messages, which is enough.
> - Agents are provisioned once by **`band.provision.mjs`** (registers the 3 agents,
>   writes `BAND_AGENT_*_{ID,HANDLE,KEY}` into `.env.local`). Idempotent.
>
> Without the agent keys in `.env.local`, `band.ts` runs the in-process
> `LocalBandOrchestrator` (fully demoable, `via: "local"`).

---

## 4. Architecture & data flow

```
Lead(DRAFTED)                     ← from B (enrichment) / A (persistence)
   │  runOutreach()  [send.ts]
   ▼
send() → Resend API ──────────────→ transition SENT   (+ messageId, sentAt)
   │
   ▼   Resend delivery webhook  [webhooks.ts → handleResendWebhook]
transition DELIVERED / OPENED
   │
   ▼   Resend inbound "email.received"  [webhooks.ts]
transition REPLIED
   │  triage()  [triage.ts]  → InsForge model gateway (or mock)
   ▼
classify GREEN / YELLOW / RED  + draft next step
   │  green/yellow → FOLLOW_UP_DRAFTED     red → LOST
   ▼   Cal.com "BOOKING_CREATED" webhook  [webhooks.ts → handleCalcomWebhook]
transition BOOKED
```

Everything writes status through the shared **`StoreProvider`** (A's contract).
Locally that's `MemStore`; in production it's A's InsForge-backed implementation
— same interface, no code change in D.

---

## 5. File-by-file reference

All files under `workstream-d-outreach/`. Imports use the `@shared/*` path alias.

### `triage.ts` — the reply-triage agent (demo-critical)
- `triage(reply, lead, opts?) → Promise<ReplyEvent>` — main entry. Summarizes,
  classifies green/yellow/red, drafts the next step. **Never throws**: any LLM
  failure degrades to the deterministic mock and is marked `via: "mock"`.
- Real LLM path = **InsForge Model Gateway** (OpenAI-compatible):
  `POST {INSFORGE_PROJECT_URL}/v1/chat/completions`, `Bearer {INSFORGE_API_KEY}`,
  `response_format: json_object`, model from `TRIAGE_MODEL`
  (default `anthropic/claude-3.5-sonnet`, routed via OpenRouter).
- `TriageLLM` interface = the swappable seam. **This is where Band plugs in.**
- Mock path = keyword classifier; opt-out signals beat incidental "yes".
- Draft logic: green → booking nudge (+Cal link); yellow → clarifier; red → none.
- Now also exposes `chatComplete()` (shared raw gateway call) and `TriageOptions.llm`
  (inject a custom agent — how `band.ts` plugs in).

### `band.ts` — Band-orchestrated triage (the Band prize)
- `createBandTriageAgent(opts?) → TriageLLM` — makes Band **load-bearing** by running
  triage as a coordinated 3-agent task: **Summarizer → Classifier → Drafter**, threading
  context between them (vs. `gatewayAgent`'s single monolithic call). Model reasoning per
  turn still runs through the InsForge gateway (`chatComplete`) underneath.
- `bandTriageRunner(opts?) → TriageRunner` — drop-in for `WebhookDeps.triage`.
- Two transports behind a `BandClient` seam: `HttpBandClient` (Band Chat Tasks REST API,
  used when `BAND_API_KEY` set — prize path, wire shape provisional) and
  `LocalBandOrchestrator` (in-process coordinator + transcript — PRD §14 fallback).
- Emits a `BandCoordination` transcript (chatId/taskId/via/turns) via the optional
  `onCoordination` callback — for the activity feed / "watch it coordinate" demo drawer.
- **Resilience:** reasoning always runs (gateway/mock); Band posting is best-effort;
  Band unreachable → local downgrade (honest `via: "local"`); hard failure → triage()'s mock.

### `send.ts` — outreach send (Resend)
- `runOutreach(leads, store, opts?)` — **the "Run outreach" button entry point.**
  Sends, persists `OutreachStatus`, advances to `SENT`, all in parallel.
- `sendMany(leads, opts?)` — parallel send without persistence (never rejects).
- `send(lead, opts?)` / `createSendProvider(opts?)` — `SendProvider` impl.
- `replyToFor(fromEmail, leadId)` — plus-addresses the sender
  (`dana+demo_1@domain`) so inbound replies map to the exact lead deterministically.
- Auto-mock when no `RESEND_API_KEY`. Real path tags every email with `lead_id`.

### `webhooks.ts` — the "nervous system"
- `handleResendWebhook(payload, deps)` — routes by `type`:
  `email.delivered`→DELIVERED, `email.opened`→OPENED,
  `email.bounced`/`complained`→LOST, `email.received`→inbound-reply flow.
- `handleCalcomWebhook(payload, deps)` — `BOOKING_CREATED`→BOOKED.
- `WebhookDeps = { store, triage?, triageOpts?, now? }` — inject store + triage.
- **Invariants:** idempotent (duplicate/out-of-order webhooks no-op via `advance()`);
  a reply proves delivery (auto-ensures DELIVERED before REPLIED); raw reply text
  is stored before triage (honesty). Inbound mapping: plus-address → from-email
  fallback. Booking mapping: `metadata.leadId` → attendee-email fallback.

### `seed.ts` — the 3 controlled demo prospects
- `demoLeads(opts?)` / `seed(store, opts?)` — Northwind Robotics, Larkspur Health,
  Meridian Analytics. `isDemo: true`, inboxes from `DEMO_INBOX_1..3`.
- `hasPlaceholderInboxes()` — true if any inbox is still `@frontrun.invalid`
  (surface a warning in the UI so we never "send" to a fake address on stage).

### `store.mock.ts` — StoreProvider stand-in (delete at integration)
- `MemStore` — in-memory `StoreProvider` that **enforces `LEAD_TRANSITIONS`**, so
  illegal state moves throw `TransitionError` in tests instead of silently on stage.

---

## 6. State machine (what D drives)

From the contract's `LEAD_TRANSITIONS`. D is responsible for these edges:
`SENT→DELIVERED`, `DELIVERED→OPENED|REPLIED`, `OPENED→REPLIED`,
`REPLIED→GREEN|YELLOW|RED`, `GREEN→FOLLOW_UP_DRAFTED|BOOKED`,
`YELLOW→FOLLOW_UP_DRAFTED`, `RED→LOST`, `FOLLOW_UP_DRAFTED→SENT|BOOKED`.
Never invent transitions the contract doesn't allow — change the contract only by
pinging the whole team (it's the merge boundary).

---

## 7. How to run

```bash
npm install            # installs typescript, @types/node, tsx
npm run typecheck      # tsc --noEmit, strict
npm run test:d         # triage + send + full-loop integration (all mock, no keys)
```

The full-loop test (`webhooks.test.ts`) reproduces the exact demo: seed 3 →
parallel outreach → deliver → reply green/yellow/red → triage → book → BOOKED,
plus duplicate-webhook and unmatched-reply edge cases.

---

## 8. Environment & keys

Stored in `.env.local` (gitignored, never commit). **Set:** `INSFORGE_PROJECT_URL`,
`INSFORGE_API_KEY`, `RESEND_API_KEY`, `HYDRA_API_KEY`.
**Still needed for the real loop:**
- `RESEND_FROM_EMAIL` + **verified Resend domain with inbound MX** ← top blocker.
- `DEMO_INBOX_1..3` — the 3 teammate prospect inboxes.
- `CALCOM_API_KEY` / `CALCOM_WEBHOOK_SECRET`, `BAND_API_KEY`.

> **Sandbox constraint:** the build sandbox can only reach GitHub + npm. It
> **cannot** reach InsForge, Resend, or Hydra — so all live-API code is verified
> via mocks here and must be smoke-tested from a real machine or the deployment.

---

## 9. Design decisions & invariants (do not regress)

1. **Framework-agnostic core.** Handlers take parsed JSON + deps, so they mount as
   Next.js routes *or* InsForge edge functions. The thin HTTP adapter (read body,
   verify signature, return 200) is the only glue left.
2. **`MOCK` mode on every external.** Auto-engages without keys; keeps CI/sandbox
   green and the demo un-sinkable on a flaky network.
3. **Swappable seams.** LLM behind `TriageLLM`; persistence behind `StoreProvider`;
   sending behind `SendProvider`. Sponsors swap by config.
4. **Honesty rules (PRD §10).** Store raw reply text; mark `via: llm|mock`; only
   ever send to the 3 controlled inboxes; respect opt-outs (red → stop, no draft).
5. **Idempotent webhooks.** Real webhook providers retry — never double-advance.

---

## 10. Integration points (the seams with A / B / C)

- **A (backend):** replace `MemStore` with A's InsForge `StoreProvider`. Same
  methods: `upsertLead`, `getLead`, `listLeads`, `transition`. Nothing else in D
  changes. A also owns Hydra analytics (D just emits clean status events).
- **B (pipeline):** D consumes `lead.draft` (an `EmailDraft`). Today the demo seed
  provides drafts; at integration, B's RocketRide pipeline fills them.
- **C (frontend):** C reads lead `status` + `replies[].nextStepDraft` to render the
  funnel and draft views, and calls `runOutreach()` from the "Run outreach" button.
  `WebhookResult.action` is log-shaped for an activity feed.

---

## 11. What's next (prioritized roadmap)

1. ~~**Band wrapper around `TriageLLM`** (prize).~~ ✅ **DONE + LIVE-verified** — `band.ts`.
   Triage runs as a real Band-coordinated Summarizer→Classifier→Drafter task (3 registered
   agents, one room per reply, @mention handoffs), gateway underneath, wired via
   `bandTriageRunner()` → `WebhookDeps.triage`, local fallback intact. Agents provisioned
   via `band.provision.mjs`; keys in `.env.local`. **Remaining:** flip the webhook's default
   `triage` to `bandTriageRunner()` at integration (kept plain until then per fallback rule).
2. ~~**Thin route adapters.**~~ ✅ **DONE** — `routes.ts` + `signatures.ts`.
   `createResendRoute(deps)` / `createCalcomRoute(deps)` return Web-standard
   `(Request)=>Response` handlers (drop into Next.js `app/api/webhooks/{resend,calcom}/
   route.ts` with `export const runtime = "nodejs"`). Verify signature (Resend=Svix,
   Cal.com=HMAC) over the raw body → parse → dispatch → 200/400/401/500. Dev-bypass
   when no secret set. Covered by `routes.test.ts` (in `test:d`). **Remaining:** C/A
   create the two `route.ts` files wiring in A's store + `bandTriageRunner()`.
3. **Resend domain + inbound MX** (external, blocking for real replies). Set
   `RESEND_FROM_EMAIL`; confirm inbound routing delivers `email.received`.
4. **Swap `MemStore` → A's InsForge store**; smoke-test one lead through the full
   loop on a real machine.
5. **Cal.com booking link** with `metadata.leadId` so bookings map deterministically
   (from-email fallback already works).
6. **Delete the mock paths** for the graded demo per honesty rules (keep them behind
   the env flag until the real path is proven).

---

## 12. Risks (and mitigations already in place)

- *Resend inbound not set up* → blocks the reply loop. Mitigation: everything else
  is done and mocked; only the domain/MX + `FROM_EMAIL` gate the live version.
- *Band unverified* → mitigation: triage already runs under a plain orchestrator;
  Band is an additive wrapper, not a dependency.
- *Email verify/open flaky* → lead on DELIVERED + REPLIED; OPENED is directional.
- *Live network on stage* → mock fallback + record a backup demo video at ~hour 7:30.

---

## 13. D's slice of the demo script

1. Hit **"Run outreach"** → 3 demo leads send in parallel, cards go Sent→Delivered.
2. Reply from the 3 inboxes: one positive, one "who are you?", one "not interested."
3. Triage flips them **green / yellow / red** live and shows the drafted next step.
4. Book the Cal.com link from the green inbox → lead flips to **BOOKED**, analytics
   updates. Close on the honesty line + "AI employee that runs the whole loop."
```

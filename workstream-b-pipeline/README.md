# Workstream B — Signal + Enrichment Pipeline

**Branch:** `workstream-b-pipeline` · **Owns:** You.com + Nimble + RocketRide prizes.

## Your job (PRD §12B)

- **Form D poller:** EDGAR full-text search for new Form D filings → emit `DETECTED` leads (`FormDSignal`).
- **Confirmation:** You.com news search — "Company X raised $Y" → set `fundingConfirmed`.
- **Enrichment:** You.com Research (cited `CompanyBrief`) + Nimble scrape (`Contact`) + email resolve (Nimble → Hunter fallback) + Reoon verify (`EmailConfidence`).
- Package **enrich → verify → draft** as **one RocketRide MCP tool**.

## Interfaces you implement

`SearchProvider`, `ScrapeProvider`, `ResolveEmailProvider`, `VerifyProvider` in `shared/types.ts`.
You produce a `Lead` with `signal` + `brief` + `contact` + `draft` filled, then hand to A's `StoreProvider`.

## Key facts (verified, PRD §4/§9)

- EDGAR full-text search is **free, keyless, same-day** — but needs a descriptive `User-Agent` header (`EDGAR_USER_AGENT`).
- Form D gives **real exec/director names + company + mailing address**. No email → resolve downstream.
- Email verify is **probabilistic** — set confidence tiers, never claim certainty.

## First moves

1. Hit EDGAR full-text search, parse the most recent Form D filings.
2. Mock the enrichment output first (so A/C unblock), then wire You.com → Nimble → Reoon.
3. Build the RocketRide pipeline tool last, once the steps work standalone.

## Definition of done

- A real Form D company appears with a real cited brief + real resolved email.
- `enrich→verify→draft` runs as one callable RocketRide tool.

## Files

```
workstream-b-pipeline/
├── pollFormD.ts      # EDGAR full-text poller → FormDSignal
├── confirm.ts        # You.com news confirmation
├── enrich.ts         # You.com Research + Nimble + Hunter + Reoon
├── draft.ts          # generate EmailDraft
└── rocketride.ts     # enrich→verify→draft as one MCP tool
```

## Current implementation

- `pollRecentFormD()` calls EDGAR full-text search for recent Form D filings and converts hits into `FormDSignal`.
- `enrichLead()` runs You.com confirmation/research, Firecrawl company-page scraping, Nimble contact discovery, Hunter fallback email resolution, and Reoon confidence verification behind the shared provider interfaces.
- Without a paid You.com API key, `YouResearchProvider` falls back to the free You.com MCP `you-search` endpoint.
- `draftOutreach()` writes the first-touch recruiting agency email.
- `runRocketRidePipeline()` is the single Track B tool-shaped entrypoint: `DETECTED → ENRICHED → DRAFTED`, optionally persisted through A's `StoreProvider`.

## Env vars

```bash
EDGAR_USER_AGENT="Frontrun hackathon your@email.com"
YOU_API_KEY="..."
YDC_API_KEY="..."
YOU_MCP_URL="https://api.you.com/mcp?profile=free"
NIMBLE_API_KEY="..."
HUNTER_API_KEY="..."
REOON_API_KEY="..."
FIRECRAWL_API_KEY="..."
```

All paid/keyed providers have safe demo fallbacks so A/C/D can integrate immediately. Add real keys for the live prize demo.

## Run it

```bash
npm run track-b:run
```

The runner loads `.env.local`, polls EDGAR, researches with You.com MCP/API, enriches, verifies confidence, and prints the drafted lead JSON. It does not persist unless you pass `-- --persist`; use `-- --include-funds` to allow fund/LP filings in the feed.

With `-- --persist`, Track B writes progressively so the frontend can render immediately.
Data fields are merged via `upsertLead` (status untouched); status advances go through
A's guarded `transition()` — `DETECTED → ENRICHED → DRAFTED`. A lead already past
DETECTED is never clobbered (the run returns it with a `resumed` step).

## RocketRide

The **enrich → draft** step runs as a native RocketRide Cloud pipeline
(`enrich.pipe`): `webhook → agent_rocketride (+ llm + memory + http_request) → response_answers`.
The agent resolves the company's real domain/email, researches the raise, and
drafts the outreach. Verified live against `https://api.rocketride.ai` — the `rr_`
key connects, `validate()` passes, and the pipe deploys.

```bash
cd workstream-b-pipeline && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
# from repo root, with ROCKETRIDE_AUTH (rr_ key) + ROCKETRIDE_URI set in .env.local:
set -a; source .env.local; set +a
ROCKETRIDE_OPENAI_KEY=sk-... npm run track-b:rocketride
```

`rocketride_client.py` connects with `ROCKETRIDE_AUTH`, validates `enrich.pipe`,
deploys it, sends a lead summary, and prints `{ connected, validated, token,
llm_key_present, enrichment }`.

> **BYOK inference.** The `rr_` key authenticates orchestration only. The agent's
> LLM node needs one provider key — `ROCKETRIDE_OPENAI_KEY` (an `sk-...` key), or
> `ROCKETRIDE_ANTHROPIC_KEY` / `ROCKETRIDE_GEMINI_KEY`. Without it the pipeline
> connects, validates, and deploys but the agent emits no draft text; the runner
> says so explicitly rather than failing silently.

# Workstream B — ingestion handoff (verified specs)

Head start for the signal + enrichment pipeline. Everything below was **verified against live APIs on 2026-07-13**
(not guessed) — including corrections to endpoints that have moved since older reference code.

## What's already here

**`edgar.ts`** — real SEC EDGAR Form D detection, **live-tested**. Keyless. Produces `DETECTED` leads in the
`shared/types.ts::Lead` shape. Exports:
- `detectLeads({ days?, keyword?, limit?, all? })` → `Lead[]` — search recent Form D, parse each filing, filter to
  likely operating startups (skips real-estate SPVs / pooled-investment funds), return up to `limit`.
- `searchRecentFormD()`, `fetchFormD()`, `looksLikeStartup()`, `toLead()` — the building blocks.

Verified live: 2,585 Form D filings in the last 14 days; e.g. parsed **Synthreo, Inc.** (Phoenix, "Other Technology",
$999,999, founders Callen Sapien / Kevin Blake / Vincent Kent) correctly.

## Push results to the backend (Workstream A)

Do **not** write raw rows to InsForge (even with the same keys) — go through A's API so the shape + state machine hold.
See [`../workstream-a-backend/INTEGRATION.md`](../workstream-a-backend/INTEGRATION.md). TL;DR:
```
POST localhost:4000/leads/bulk   { "leads": Lead[] }        # detected leads
POST localhost:4000/leads/:id/transition  { "to": "ENRICHED" | "DRAFTED" | ... }
```

---

## Verified provider specs (corrected)

### SEC EDGAR — detection (keyless) ✅ in edgar.ts
- Search: `GET https://efts.sec.gov/LATEST/search-index?q=&forms=D&startdt=YYYY-MM-DD&enddt=YYYY-MM-DD`
  header `User-Agent: <descriptive, e.g. Frontrun … email>`. Read `hits.hits[]._source` → `ciks`, `adsh`, `file_date`, `display_names`.
- Filing: `GET https://www.sec.gov/Archives/edgar/data/{cik}/{accession-no-dashes}/primary_doc.xml` (same UA). Parse XML.

### InsForge AI gateway — drafts (LLM) ✅ live-tested, returns real completions
**The path in older notes was wrong on two counts.** Correct:
- `POST {INSFORGE_PROJECT_URL}/api/ai/chat/completion` — **singular `completion`, NO `/v1/`**.
- Auth: `Authorization: Bearer <ik_ project key>` — the **same key as the database**. No separate AI key on InsForge Cloud.
- Body is **camelCase**: `{ model, messages:[{role,content}], maxTokens, temperature, stream }`.
  System prompt goes in `messages` as `{role:"system"}` — there is **no** top-level `systemPrompt`, and it's `maxTokens` **not** `max_tokens`.
- Response: read **`.text`** (not `choices[0].message.content`). Also `tool_calls`, `annotations`, `metadata.usage`.
- Models: OpenRouter `provider/model` strings; `GET {base}/api/ai/models` lists 433. Verified: `anthropic/claude-sonnet-4.5`
  (also `anthropic/claude-opus-4.5`, `anthropic/claude-haiku-4.5`).
```bash
curl -X POST "$INSFORGE_PROJECT_URL/api/ai/chat/completion" \
  -H "Authorization: Bearer $INSFORGE_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"anthropic/claude-sonnet-4.5","messages":[{"role":"system","content":"You write concise recruiting outreach."},{"role":"user","content":"..."}],"maxTokens":380}'
# → { "text": "..." }
```

### You.com — research brief + funding confirmation (needs YDC key)
- Search: `GET https://ydc-index.io/v1/search?query=…&freshness=month&count=6`, header `X-API-Key: <key>`.
  Response is **nested**: read `results.web[]` → `{ url, title, description/snippets }` (not a flat `results[]`).
- Research: `POST https://api.you.com/v1/research` — **host moved to `api.you.com`**. Header `X-API-Key`, JSON body
  `{ "input": "<question>", "research_effort": "lite|standard|deep|exhaustive" }` — the field is **`input`, not `query`**.

### Nimble — web + contact enrichment (needs Nimble key)
- Current: `POST https://sdk.nimbleway.com/v1/extract`, `Authorization: Bearer <key>`.
- Legacy (still works): `POST https://api.webit.live/api/v1/realtime/web`, Bearer, body
  `{ url, method:"GET", render:true, country:"US", format:"html" }` → read `data.html_content`.

### Hunter + Reoon — email resolve + verify (needs keys; auth is a **query-string** key, not a header)
- Hunter find: `GET https://api.hunter.io/v2/email-finder?domain=&first_name=&last_name=&api_key=` → `data.email`, `data.score` (0–100).
- Hunter verify: `GET https://api.hunter.io/v2/email-verifier?email=&api_key=` → `data.status` (valid|invalid|accept_all|webmail|disposable|unknown), `data.score`.
- Reoon: `GET https://emailverifier.reoon.com/api/v1/verify?email=&key=&mode=power` (or `mode=quick`) → `status` (valid|invalid|catch_all|unknown|disposable).

## Honesty rules (PRD §14) — no fabricated data
- Email verification is probabilistic (Gmail/catch-all return OK) — surface a **confidence tier**, never "certain".
- Names/phone/address come from SEC (real). Email is **resolved** downstream — mark `emailConfidence: "unverified"` until a verifier confirms.
- If a provider key is missing, leave the field empty — do **not** mock it.

## Env vars
```
EDGAR_USER_AGENT="Frontrun … your-email"     # keyless, just a UA
INSFORGE_PROJECT_URL=  INSFORGE_API_KEY=     # ik_ project key (drafts + shared store)
YDC_API_KEY=  NIMBLE_API_KEY=  HUNTER_API_KEY=  REOON_API_KEY=
```

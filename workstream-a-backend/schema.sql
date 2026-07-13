-- Workstream A — InsForge Postgres schema. Mirrors shared/types.ts::Lead.
-- Nested objects (signal, brief, contact, draft, outreach, replies) are JSONB so
-- the row shape tracks the contract with no migrations when B/C/D add fields.
-- Run through InsForge migrations, then set INSFORGE_* env vars to flip store.ts.

create table if not exists leads (
  id          text primary key,
  status      text not null,                       -- LeadStatus enum value
  is_demo     boolean not null default false,      -- the 3 parallel-demo companies

  -- detection (B) — kept as a column for cheap ordering + a JSONB copy
  filed_at    timestamptz,                         -- signal.filedAt (freshness)
  signal      jsonb not null,                      -- FormDSignal

  -- enrichment (B)
  brief       jsonb,                               -- CompanyBrief
  contact     jsonb,                               -- Contact

  -- draft (B/D)
  draft       jsonb,                               -- EmailDraft

  -- outreach + reply loop (D)
  outreach    jsonb,                               -- OutreachStatus
  replies     jsonb default '[]'::jsonb,           -- ReplyEvent[]

  -- bookkeeping (A)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists leads_status_idx   on leads (status);
create index if not exists leads_filed_at_idx  on leads (filed_at desc);
create index if not exists leads_is_demo_idx    on leads (is_demo);

-- Hydra analytics surface (columnar). As a plain Postgres view it already feeds
-- FunnelAnalytics; on Hydra this becomes a columnar table for fast aggregation.
create or replace view lead_funnel as
select
  status,
  count(*)                                              as count,
  count(*) filter (where outreach->>'deliveredAt' is not null) as delivered,
  count(*) filter (where jsonb_array_length(coalesce(replies,'[]'::jsonb)) > 0) as replied
from leads
group by status;

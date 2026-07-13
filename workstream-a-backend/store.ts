/**
 * Workstream A — StoreProvider implementations.
 *
 *  - `InMemoryStore`  : the reference implementation. Zero deps, zero keys, so
 *                       the whole team is unblocked at minute one. Enforces the
 *                       state machine on every transition.
 *  - `InsforgeStore`  : same interface, backed by InsForge Postgres (the prize).
 *                       Flips on automatically once INSFORGE keys are set — no
 *                       caller changes anything (PRD §11: swap by config).
 *
 * The InsForge adapter talks to InsForge's raw-SQL endpoint
 * (`POST {PROJECT_URL}/api/database/advance/rawsql`, body `{ query, params }`,
 * auth `Authorization: Bearer <project API key>`). Raw SQL — not the PostgREST
 * records layer — because it gives a real `INSERT … ON CONFLICT DO UPDATE`
 * upsert, exact camelCase↔snake_case column mapping, and a `GROUP BY` for the
 * analytics strip, all behind one documented endpoint.
 *
 * Everyone (B, C, D) codes against the `StoreProvider` interface in
 * shared/types.ts and never touches these internals.
 */
import { Lead, LeadStatus, StoreProvider } from "../shared/types";
import { assertTransition } from "./stateMachine";

function now(): string {
  return new Date().toISOString();
}

/** Fill server-owned bookkeeping fields on write. */
function stamp(lead: Lead, existing?: Lead): Lead {
  return {
    ...lead,
    createdAt: existing?.createdAt ?? lead.createdAt ?? now(),
    updatedAt: now(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory (default)
// ─────────────────────────────────────────────────────────────────────────────
export class InMemoryStore implements StoreProvider {
  private leads = new Map<string, Lead>();

  async upsertLead(lead: Lead): Promise<Lead> {
    const existing = this.leads.get(lead.id);
    const saved = stamp(lead, existing);
    this.leads.set(saved.id, saved);
    return saved;
  }

  async getLead(id: string): Promise<Lead | null> {
    return this.leads.get(id) ?? null;
  }

  async listLeads(): Promise<Lead[]> {
    // newest signal first — handy for the frontend feed.
    return [...this.leads.values()].sort((a, b) =>
      (b.signal?.filedAt ?? "").localeCompare(a.signal?.filedAt ?? "")
    );
  }

  async transition(id: string, to: LeadStatus): Promise<Lead> {
    const lead = this.leads.get(id);
    if (!lead) throw new Error(`Lead ${id} not found`);
    assertTransition(lead.status, to); // throws IllegalTransitionError on bad jump
    if (lead.status === to) return lead; // idempotent (e.g. duplicate delivery webhook)
    const saved: Lead = { ...lead, status: to, updatedAt: now() };
    this.leads.set(id, saved);
    return saved;
  }

  /** Test/demo helper — not part of the interface. */
  clear(): void {
    this.leads.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Row mapping: Lead (camelCase) ↔ `leads` row (snake_case, see schema.sql).
// Exported so the mapping is unit-tested without a network round-trip.
// ─────────────────────────────────────────────────────────────────────────────

/** JSON-encode for a jsonb param; null/undefined → SQL NULL. */
function j(v: unknown): string | null {
  return v === undefined || v === null ? null : JSON.stringify(v);
}
/** Parse a jsonb value that may come back as an object (typical) or a string. */
function p(v: unknown): any {
  return typeof v === "string" ? JSON.parse(v) : v;
}

/** A `leads` table row as InsForge returns it from `select *`. */
export interface LeadRow {
  id: string;
  status: string;
  is_demo: boolean;
  filed_at: string | null;
  signal: unknown;
  brief: unknown;
  contact: unknown;
  draft: unknown;
  outreach: unknown;
  replies: unknown;
  created_at: string;
  updated_at: string;
}

/** Reconstruct a Lead from a DB row (handles object- or string-encoded jsonb). */
export function rowToLead(r: LeadRow | Record<string, any>): Lead {
  return {
    id: r.id,
    status: r.status as LeadStatus,
    isDemo: !!r.is_demo,
    signal: p(r.signal),
    brief: r.brief == null ? undefined : p(r.brief),
    contact: r.contact == null ? undefined : p(r.contact),
    draft: r.draft == null ? undefined : p(r.draft),
    outreach: r.outreach == null ? undefined : p(r.outreach),
    replies: r.replies == null ? [] : p(r.replies),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Ordered params for the upsert INSERT (matches the column list below). */
export function leadToParams(lead: Lead): unknown[] {
  return [
    lead.id,
    lead.status,
    !!lead.isDemo,
    lead.signal?.filedAt ?? null,
    j(lead.signal),
    j(lead.brief),
    j(lead.contact),
    j(lead.draft),
    j(lead.outreach),
    j(lead.replies ?? []),
    lead.createdAt,
    lead.updatedAt,
  ];
}

/**
 * Split a .sql script into individual statements for the raw-SQL endpoint
 * (InsForge does not document multi-statement execution). Strips full-line
 * `--` comments; safe for schema.sql (no semicolons inside string literals).
 */
export function splitSql(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// InsForge-backed (the prize). Persists each Lead as a row keyed by id, with the
// nested contract objects (signal/brief/contact/draft/outreach/replies) as jsonb.
// The state-machine guard still runs here — persistence changes, legality does not.
// ─────────────────────────────────────────────────────────────────────────────
const RAWSQL_PATH = "/api/database/advance/rawsql";

export class InsforgeStore implements StoreProvider {
  private base: string;
  private key: string;
  private table: string;

  constructor(opts?: { base?: string; key?: string; table?: string }) {
    this.base = (opts?.base ?? process.env.INSFORGE_PROJECT_URL ?? "").replace(/\/+$/, "");
    this.key = opts?.key ?? process.env.INSFORGE_API_KEY ?? "";
    this.table = opts?.table ?? process.env.INSFORGE_LEADS_TABLE ?? "leads";
  }

  /** The single integration point: parameterized SQL via InsForge's raw-SQL API. */
  async sql<T = any>(query: string, params: unknown[] = []): Promise<T[]> {
    const res = await fetch(`${this.base}${RAWSQL_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.key}`,
        "x-api-key": this.key, // InsForge accepts either; send both to be safe
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, params }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`InsForge SQL ${res.status}: ${body.slice(0, 300)}`);
    }
    const data: any = await res.json().catch(() => ({}));
    return (data?.rows ?? (Array.isArray(data) ? data : [])) as T[];
  }

  async upsertLead(lead: Lead): Promise<Lead> {
    const existing = await this.getLead(lead.id);
    const saved = stamp(lead, existing ?? undefined);
    const rows = await this.sql<LeadRow>(
      `insert into ${this.table}
         (id, status, is_demo, filed_at, signal, brief, contact, draft, outreach, replies, created_at, updated_at)
       values ($1, $2, $3, $4::timestamptz, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::timestamptz, $12::timestamptz)
       on conflict (id) do update set
         status     = excluded.status,
         is_demo    = excluded.is_demo,
         filed_at   = excluded.filed_at,
         signal     = excluded.signal,
         brief      = excluded.brief,
         contact    = excluded.contact,
         draft      = excluded.draft,
         outreach   = excluded.outreach,
         replies    = excluded.replies,
         updated_at = excluded.updated_at
       returning *`,
      leadToParams(saved)
    );
    return rows[0] ? rowToLead(rows[0]) : saved;
  }

  async getLead(id: string): Promise<Lead | null> {
    const rows = await this.sql<LeadRow>(`select * from ${this.table} where id = $1 limit 1`, [id]);
    return rows[0] ? rowToLead(rows[0]) : null;
  }

  async listLeads(): Promise<Lead[]> {
    const rows = await this.sql<LeadRow>(`select * from ${this.table} order by filed_at desc nulls last`);
    return rows.map(rowToLead);
  }

  async transition(id: string, to: LeadStatus): Promise<Lead> {
    const lead = await this.getLead(id);
    if (!lead) throw new Error(`Lead ${id} not found`);
    assertTransition(lead.status, to); // throws IllegalTransitionError on bad jump
    if (lead.status === to) return lead; // idempotent
    return this.upsertLead({ ...lead, status: to });
  }

  /**
   * Create the leads table + indexes + funnel view (idempotent). Pass the text
   * of schema.sql. Runs each statement separately (see splitSql).
   */
  async init(schemaSql: string): Promise<void> {
    for (const stmt of splitSql(schemaSql)) await this.sql(stmt);
  }

  /** Health check: SELECT 1 round-trip. Returns true if InsForge answers. */
  async ping(): Promise<boolean> {
    try {
      await this.sql(`select 1 as ok`);
      return true;
    } catch {
      return false;
    }
  }

  /** Real columnar-style funnel via SQL GROUP BY (the analytics-strip story). */
  async funnelCounts(): Promise<{ status: string; count: number }[]> {
    return this.sql<{ status: string; count: number }>(
      `select status, count(*)::int as count from ${this.table} group by status`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory + singleton. Callers do: `import { store } from "./store"`.
// Flips to InsForge automatically once both env vars are present.
// ─────────────────────────────────────────────────────────────────────────────
export function createStore(): StoreProvider {
  const useInsforge = !!process.env.INSFORGE_API_KEY && !!process.env.INSFORGE_PROJECT_URL;
  return useInsforge ? new InsforgeStore() : new InMemoryStore();
}

export const store: StoreProvider = createStore();

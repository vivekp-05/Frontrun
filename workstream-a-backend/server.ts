/**
 * Workstream A — the status API that C (frontend) and B/D (agents) call.
 *
 * Zero dependencies (Node's built-in http) so it runs with `tsx server.ts` and
 * no install friction. It exposes the StoreProvider + AnalyticsProvider surface
 * over HTTP with CORS, so the Next.js dashboard on another port can hit it.
 *
 *   GET    /health
 *   GET    /leads                     → Lead[]
 *   GET    /leads/:id                 → Lead | 404
 *   POST   /leads                     → upsert (body: Lead) → Lead
 *   POST   /leads/:id/transition      → body: { to: LeadStatus } → Lead | 409 (illegal)
 *   GET    /analytics                 → FunnelAnalytics
 *   POST   /seed                      → load seed leads
 *   POST   /reset                     → clear + reseed (in-memory only)
 *
 * When InsForge is wired, the same routes serve straight from Postgres; the
 * frontend contract does not change.
 */
import "./env"; // load repo-root .env.local before the store singleton is built
import http from "node:http";
import { Lead, LeadStatus } from "../shared/types";
import { store } from "./store";
import { createAnalytics } from "./analytics";
import { seedInto, SEED_LEADS } from "./seed";
import { IllegalTransitionError } from "./stateMachine";

const analytics = createAnalytics(store);
const PORT = Number(process.env.PORT ?? 4000);

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (method === "OPTIONS") return send(res, 204, {});

    if (method === "GET" && (path === "/" || path === "/health"))
      return send(res, 200, { ok: true, service: "frontrun-backend", backend: process.env.INSFORGE_API_KEY ? "insforge" : "in-memory" });

    if (method === "GET" && path === "/leads")
      return send(res, 200, await store.listLeads());

    if (method === "GET" && path === "/analytics")
      return send(res, 200, await analytics.funnel());

    if (method === "POST" && path === "/leads") {
      const lead = await readBody(req);
      if (!lead?.id) return send(res, 400, { error: "Lead.id required" });
      return send(res, 200, await store.upsertLead(lead));
    }

    // Batch ingestion — the pipeline (Workstream B) pushes detected/enriched leads here.
    if (method === "POST" && path === "/leads/bulk") {
      const body = await readBody(req);
      const arr: Lead[] = Array.isArray(body) ? body : body?.leads;
      if (!Array.isArray(arr)) return send(res, 400, { error: "Body must be Lead[] or { leads: Lead[] }" });
      let upserted = 0;
      const skipped: string[] = [];
      for (const l of arr) {
        if (l?.id) { await store.upsertLead(l); upserted++; }
        else skipped.push(JSON.stringify(l)?.slice(0, 60) ?? "?");
      }
      return send(res, 200, { upserted, skipped: skipped.length });
    }

    if (method === "POST" && path === "/seed") {
      const n = await seedInto(store);
      return send(res, 200, { ok: true, seeded: n });
    }

    if (method === "POST" && path === "/reset") {
      if ("clear" in store && typeof (store as any).clear === "function") {
        (store as any).clear();
        await seedInto(store);
        return send(res, 200, { ok: true, reseeded: SEED_LEADS.length });
      }
      return send(res, 400, { error: "reset only supported on in-memory store" });
    }

    // /leads/:id  and  /leads/:id/transition
    const m = path.match(/^\/leads\/([^/]+)(\/transition)?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const isTransition = !!m[2];
      if (method === "GET" && !isTransition) {
        const lead = await store.getLead(id);
        return lead ? send(res, 200, lead) : send(res, 404, { error: `Lead ${id} not found` });
      }
      if (method === "POST" && isTransition) {
        const { to } = await readBody(req);
        if (!to || !(Object.values(LeadStatus) as string[]).includes(to))
          return send(res, 400, { error: `Body { to } must be a LeadStatus. Got: ${to}` });
        const lead = await store.transition(id, to as LeadStatus);
        return send(res, 200, lead);
      }
    }

    return send(res, 404, { error: `No route for ${method} ${path}` });
  } catch (err: any) {
    if (err instanceof IllegalTransitionError)
      return send(res, 409, { error: err.message, from: err.from, to: err.to, allowed: err.allowed });
    return send(res, 500, { error: String(err?.message ?? err) });
  }
});

// Boot clean — real leads come from Workstream B's ingestion (POST /leads[/bulk]).
// Set SEED_DEMO=1 for local dev without ingestion (loads fixture leads).
server.listen(PORT, async () => {
  let note = "no seed (ingestion writes real leads here)";
  if (process.env.SEED_DEMO === "1") {
    const n = await seedInto(store);
    note = `${n} demo fixtures seeded (SEED_DEMO=1)`;
  }
  const count = (await store.listLeads()).length;
  console.log(
    `Frontrun backend (Workstream A) on http://localhost:${PORT}  ·  ${count} leads in store  ·  ${note}  ·  store: ${process.env.INSFORGE_API_KEY ? "InsForge" : "in-memory"}`
  );
});

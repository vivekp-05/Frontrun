/**
 * Workstream A tests — run with `npm test` (tsx store.test.ts).
 * Covers the state-machine guard, store CRUD, and analytics. No test framework
 * needed; exits non-zero on any failure so CI catches it.
 */
import { LeadStatus, Lead } from "../shared/types";
import { InMemoryStore, rowToLead, leadToParams, splitSql } from "./store";
import { canTransition, IllegalTransitionError } from "./stateMachine";
import { computeFunnel } from "./analytics";
import { SEED_LEADS, seedInto } from "./seed";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) { passed++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name); }
}
async function throws(name: string, fn: () => Promise<unknown>, type?: any) {
  try { await fn(); ok(name, false); }
  catch (e) { ok(name, type ? e instanceof type : true); }
}

async function main() {
  const store = new InMemoryStore();

  // ── seed + CRUD ──
  const n = await seedInto(store);
  ok("seed loads all leads", n === SEED_LEADS.length && (await store.listLeads()).length === n);

  const demo = await store.getLead("9001");
  ok("getLead returns a demo lead at DRAFTED", demo?.status === LeadStatus.DRAFTED && demo?.isDemo === true);
  ok("getLead(missing) → null", (await store.getLead("nope")) === null);

  // ── state machine: legality table ──
  ok("DETECTED → ENRICHED is legal", canTransition(LeadStatus.DETECTED, LeadStatus.ENRICHED));
  ok("DETECTED → BOOKED is illegal", !canTransition(LeadStatus.DETECTED, LeadStatus.BOOKED));
  ok("REPLIED → GREEN is legal", canTransition(LeadStatus.REPLIED, LeadStatus.GREEN));
  ok("BOOKED is terminal", canTransition(LeadStatus.BOOKED, LeadStatus.SENT) === false);

  // ── store.transition enforces the machine ──
  const real = await store.transition("2141371", LeadStatus.ENRICHED);
  ok("transition DETECTED → ENRICHED persists", real.status === LeadStatus.ENRICHED);
  await throws("transition ENRICHED → BOOKED throws IllegalTransitionError",
    () => store.transition("2141371", LeadStatus.BOOKED), IllegalTransitionError);
  await throws("transition on missing lead throws", () => store.transition("nope", LeadStatus.ENRICHED));

  // ── full happy path on a demo lead ──
  const path = [LeadStatus.SENT, LeadStatus.DELIVERED, LeadStatus.REPLIED, LeadStatus.GREEN, LeadStatus.BOOKED];
  let last: Lead | null = null;
  for (const s of path) last = await store.transition("9001", s);
  ok("demo lead walks DRAFTED → … → BOOKED", last?.status === LeadStatus.BOOKED);
  await throws("cannot transition out of BOOKED (terminal)", () => store.transition("9001", LeadStatus.SENT), IllegalTransitionError);

  // idempotent same-state (e.g. duplicate delivery webhook)
  await store.transition("9002", LeadStatus.SENT);
  await store.transition("9002", LeadStatus.DELIVERED);
  const again = await store.transition("9002", LeadStatus.DELIVERED);
  ok("re-applying same status is a no-op", again.status === LeadStatus.DELIVERED);

  // ── analytics ──
  const leads = await store.listLeads();
  const a = computeFunnel(leads);
  const sumCounts = Object.values(a.counts).reduce((x, y) => x + y, 0);
  ok("funnel counts sum to total leads", sumCounts === leads.length);
  ok("every LeadStatus present in counts", Object.values(LeadStatus).every((s) => s in a.counts));

  // synthetic analytics: 1 delivered + replied green
  const synthetic: Lead[] = [{
    id: "t1", status: LeadStatus.GREEN, isDemo: true,
    signal: { accessionNumber: "t", companyName: "T", relatedPersons: [], filedAt: "2026-07-11" },
    outreach: { sentAt: "2026-07-11T10:00:00Z", deliveredAt: "2026-07-11T10:00:05Z" },
    replies: [{ id: "r", receivedAt: "2026-07-11T10:30:00Z", from: "f", rawText: "yes", classification: "green" }],
    createdAt: "x", updatedAt: "x",
  }];
  const b = computeFunnel(synthetic);
  ok("replyRate = replied/delivered = 1.0", b.replyRate === 1);
  ok("avgResponseTimeMs computed (30 min)", b.avgResponseTimeMs === 30 * 60 * 1000);
  ok("greenRedRatio with 1 green 0 red = Infinity", b.greenRedRatio === Infinity);

  // ── InsForge row mapping (no network) ──
  const sample = SEED_LEADS[0];
  const row = {
    id: sample.id, status: sample.status, is_demo: sample.isDemo, filed_at: sample.signal.filedAt,
    signal: sample.signal, brief: null, contact: null, draft: null, outreach: null,
    replies: sample.replies ?? [], created_at: sample.createdAt, updated_at: sample.updatedAt,
  };
  const back = rowToLead(row);
  ok("rowToLead maps snake_case row → Lead",
    back.id === sample.id && back.isDemo === sample.isDemo &&
    back.signal.companyName === sample.signal.companyName && Array.isArray(back.replies));
  ok("rowToLead: null jsonb columns → undefined", back.brief === undefined && back.outreach === undefined);
  // some drivers return jsonb as a string — mapper must parse both
  const back2 = rowToLead({ ...row, signal: JSON.stringify(sample.signal), replies: JSON.stringify([]) });
  ok("rowToLead parses stringified jsonb", back2.signal.companyName === sample.signal.companyName && back2.replies.length === 0);

  const params = leadToParams(sample);
  ok("leadToParams: 12 ordered params, id first, is_demo boolean",
    params.length === 12 && params[0] === sample.id && typeof params[2] === "boolean");
  ok("leadToParams: jsonb params are JSON strings", typeof params[4] === "string" && JSON.parse(params[4] as string).companyName === sample.signal.companyName);

  const stmts = splitSql("-- comment\ncreate table a (id text);\n\ncreate index i on a(id);\n");
  ok("splitSql drops comments + splits statements", stmts.length === 2 && stmts[0].startsWith("create table"));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();

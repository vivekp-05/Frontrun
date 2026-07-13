/**
 * Real SEC EDGAR Form D detection — the signal (PRD §4). Keyless, same-day, free.
 * No hardcoded companies: every lead here is a company that actually just filed a
 * Form D (raised private capital). SEC only requires a descriptive User-Agent.
 *
 *   1. full-text search  → recent Form D filings (CIK, accession, date, name)
 *   2. primary_doc.xml   → real entity, address, amount raised, related persons
 *
 * Produces DETECTED leads in the thin `shared/types.ts` shape.
 */
/// <reference types="node" />
import { Lead, LeadStatus, FormDSignal } from "../shared/types";

const UA = process.env.EDGAR_USER_AGENT || "Frontrun hackathon sharique.khatri@gmail.com";
const FTS = "https://efts.sec.gov/LATEST/search-index";

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── tiny XML helpers (Form D primary_doc.xml is small, well-formed) ──
function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : "";
}
function block(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : "";
}
function allBlocks(xml: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

export interface FtsHit {
  cik: string;
  accession: string;
  fileDate: string;
  name: string;
}

/** Full-text search for recent Form D filings, newest first. */
export async function searchRecentFormD(opts?: {
  days?: number;
  keyword?: string;
  from?: number;
}): Promise<FtsHit[]> {
  const end = new Date();
  const start = new Date(end.getTime() - (opts?.days ?? 14) * 86400000);
  const q = opts?.keyword ? encodeURIComponent(`"${opts.keyword}"`) : "";
  const url = `${FTS}?q=${q}&forms=D&startdt=${ymd(start)}&enddt=${ymd(end)}&from=${opts?.from ?? 0}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`EDGAR search ${res.status}`);
  const data: any = await res.json();
  const hits: any[] = data?.hits?.hits ?? [];
  return hits.map((h) => {
    const s = h._source || {};
    return {
      cik: String(s.ciks?.[0] || "").replace(/^0+/, ""),
      accession: s.adsh || String(h._id || "").split(":")[0],
      fileDate: s.file_date || "",
      name: String(s.display_names?.[0] || "").replace(/\s*\(CIK.*$/, "").trim(),
    };
  });
}

export interface ParsedFormD {
  cik: string;
  accession: string;
  entityName: string;
  city: string;
  state: string;
  phone: string;
  industryGroup: string;
  amountRaised: string;
  fileDate: string;
  persons: { name: string; role: string; isExec: boolean }[];
  address: string;
}

/** Fetch + parse one Form D filing into its real fields. */
export async function fetchFormD(cik: string, accession: string, fileDate = ""): Promise<ParsedFormD> {
  const acc = accession.replace(/-/g, "");
  const bareCik = cik.replace(/^0+/, "");
  const url = `https://www.sec.gov/Archives/edgar/data/${bareCik}/${acc}/primary_doc.xml`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Form D fetch ${res.status}`);
  const xml = await res.text();

  const issuer = block(xml, "primaryIssuer");
  const addr = block(issuer, "issuerAddress");
  const offering = block(xml, "offeringData");
  const amounts = block(offering, "offeringSalesAmounts");

  const persons = allBlocks(block(xml, "relatedPersonsList"), "relatedPersonInfo").map((p) => {
    const nameBlk = block(p, "relatedPersonName");
    const first = tag(nameBlk, "firstName");
    const last = tag(nameBlk, "lastName");
    const rels = allBlocks(block(p, "relatedPersonRelationshipList"), "relationship").map((r) => r.trim());
    const clar = tag(p, "relationshipClarification");
    const role = clar || rels.join(", ") || "Related Person";
    return { name: `${first} ${last}`.trim(), role, isExec: rels.includes("Executive Officer") };
  });

  const street1 = tag(addr, "street1");
  const city = tag(addr, "city");
  const state = tag(addr, "stateOrCountryDescription") || tag(addr, "stateOrCountry");
  const zip = tag(addr, "zipCode");

  return {
    cik: bareCik,
    accession,
    entityName: tag(issuer, "entityName"),
    city,
    state,
    phone: tag(issuer, "issuerPhoneNumber"),
    industryGroup: tag(block(offering, "industryGroup"), "industryGroupType"),
    amountRaised: tag(amounts, "totalAmountSold"),
    fileDate,
    persons,
    address: [street1, city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
  };
}

/**
 * Heuristic: is this an operating startup likely to hire (vs. a real-estate SPV
 * or pooled investment fund, which dominate Form D volume)? Keeps the feed useful
 * without inventing anything — it only filters real filings.
 */
const FUND_RE = /pooled investment|investment fund|real estate|reit|oil|gas|mineral|agricultur|bank|insurance/i;
export function looksLikeStartup(p: ParsedFormD): boolean {
  if (!p.entityName) return false;
  if (FUND_RE.test(p.industryGroup)) return false;
  const amt = parseFloat(p.amountRaised);
  if (!(amt > 0)) return false; // undisclosed/zero → skip
  // an operating company usually names an Executive Officer; funds name only managers/directors
  return p.persons.some((x) => x.isExec) || /technolog|health|biotech|pharma|software|comput|energy|consumer|manufactur/i.test(p.industryGroup);
}

/** Build a DETECTED Lead (thin contract) from a parsed filing. */
export function toLead(p: ParsedFormD): Lead {
  const now = new Date().toISOString();
  const relatedPersons = p.persons.map((x) => (x.role && x.role !== "Related Person" ? `${x.name} (${x.role})` : x.name));
  const signal: FormDSignal = {
    accessionNumber: p.accession,
    companyName: p.entityName,
    relatedPersons,
    address: p.address || undefined,
    amountRaised: p.amountRaised || undefined,
    filedAt: p.fileDate || now.slice(0, 10),
    edgarUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${p.cik}&type=D`,
  };
  return {
    id: p.cik,
    status: LeadStatus.DETECTED,
    isDemo: false,
    signal,
    createdAt: now,
    updatedAt: now,
    replies: [],
  };
}

/** Run `fn` over `items` with bounded concurrency. */
async function mapPool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

/**
 * Detect real, recent funded startups from EDGAR. Searches recent Form D filings,
 * fetches + parses each (bounded), filters to likely operating startups, and
 * returns up to `limit` DETECTED leads. Set `all: true` to skip the startup filter.
 */
export async function detectLeads(opts?: {
  days?: number;
  keyword?: string;
  limit?: number;
  maxFetch?: number;
  all?: boolean;
}): Promise<Lead[]> {
  const limit = opts?.limit ?? 12;
  const maxFetch = opts?.maxFetch ?? 45;
  const hits = (await searchRecentFormD({ days: opts?.days, keyword: opts?.keyword })).slice(0, maxFetch);

  const leads: Lead[] = [];
  // process in chunks, stop once we have enough that pass the filter
  for (let i = 0; i < hits.length && leads.length < limit; i += 6) {
    const chunk = hits.slice(i, i + 6);
    const parsed = await mapPool(chunk, 6, async (h) => {
      try {
        return await fetchFormD(h.cik, h.accession, h.fileDate);
      } catch {
        return null;
      }
    });
    for (const p of parsed) {
      if (!p) continue;
      if (opts?.all || looksLikeStartup(p)) leads.push(toLead(p));
      if (leads.length >= limit) break;
    }
  }
  return leads;
}

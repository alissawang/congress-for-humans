const WORKER_URL = "https://congress-api-cache.alissa-wang.workers.dev";

import { coerceList, billKey } from "./utils.js";

async function getJson(path, params = {}) {
  const url = new URL(WORKER_URL);
  url.searchParams.set("path", path.replace(/^\/+/, ""));
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} | ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function* paginate(path, { limit = 250, params = {}, sleepMs = 75 } = {}) {
  let offset = 0;
  limit = Math.min(limit, 250);

  while (true) {
    const page = await getJson(path, { ...params, offset, limit });
    yield page;
    if (!page?.pagination?.next) break;
    offset += limit;
    if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs));
  }
}

async function getMemberDetails(bioguideId) {
  const { member } = await getJson(`member/${bioguideId}`);
  return member;
}

// The sponsored-legislation list mixes bills and floor amendments, and amendments
// arrive in a different shape: `amendmentNumber` in place of `number`, a null
// `type`, and no title, description or policyArea. Checked three ways because only
// the number field is reliably present across chambers.
function isAmendment(item) {
  if (item?.amendmentNumber !== undefined && item?.amendmentNumber !== null) return true;
  if (/AMDT$/i.test(item?.type ?? "")) return true;
  return /\/amendment\//i.test(item?.url ?? "");
}

async function getSponsoredLegislation(bioguideId) {
  const out = [];
  const listPath = `/member/${bioguideId}/sponsored-legislation`;

  for await (const page of paginate(listPath, { limit: 250 })) {
    const items =
      coerceList(page.sponsoredLegislation) ||
      coerceList(page.results) ||
      coerceList(page.items);
    out.push(...items.filter((item) => !isAmendment(item)));
  }
  return out;
}

// What each bill actually does, from the worker: a CRS summary where one exists,
// otherwise every distinct title the bill carries, purpose clause first — or the
// opening of the bill's own text where those titles say almost nothing. Writes
// {text, source} onto bill._description and leaves the rest untouched.
async function getBillDescriptions(bills) {
  const refs = bills
    .filter((b) => b?.congress && b?.type && b?.number != null)
    .map((b) => ({ id: billKey(b), congress: b.congress, type: b.type, number: b.number }));
  if (!refs.length) return { checked: 0, bySource: {} };

  const res = await fetch(`${WORKER_URL}/bill-descriptions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bills: refs }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} | ${body.slice(0, 300)}`);
  }

  const { descriptions, bySource } = await res.json();
  for (const bill of bills) {
    const found = descriptions?.[billKey(bill)];
    if (found?.text) bill._description = { text: String(found.text), source: found.source };
  }
  return { checked: refs.length, bySource: bySource || {} };
}

// Chamber-wide counts are keyed only by congress, so they're identical for every
// member and every year within one. Cache the promise rather than the value, so
// concurrent callers share a single request instead of racing duplicates.
const billCountsByCongress = new Map();

function countBillsByPolicyArea(congress_session_num) {
  const key = String(congress_session_num);
  let pending = billCountsByCongress.get(key);
  if (!pending) {
    pending = fetchBillCountsByPolicyArea(congress_session_num).catch((err) => {
      // Never cache a failure — the next selection should get a fresh attempt.
      billCountsByCongress.delete(key);
      throw err;
    });
    billCountsByCongress.set(key, pending);
  }
  return pending;
}

async function fetchBillCountsByPolicyArea(congress_session_num) {
  const url = new URL(`${WORKER_URL}/bill-counts`);
  url.searchParams.set("congress", String(congress_session_num));

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} | ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function searchMembers({ congress, q, state, district } = {}) {
  const url = new URL(`${WORKER_URL}/member-search`);
  if (congress !== undefined) url.searchParams.set("congress", String(congress));
  if (q) url.searchParams.set("q", q);
  if (state) url.searchParams.set("state", state);
  if (district !== undefined && district !== "") url.searchParams.set("district", String(district));

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} | ${body.slice(0, 300)}`);
  }
  return res.json();
}

export { getMemberDetails, getSponsoredLegislation, getBillDescriptions, countBillsByPolicyArea, searchMembers };
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

// House and Senate origins are told apart by the bill type prefix alone — no
// separate lookup needed.
const CHAMBER_BY_TYPE = {
  HR: "House", HRES: "House", HJRES: "House", HCONRES: "House",
  S: "Senate", SRES: "Senate", SJRES: "Senate", SCONRES: "Senate",
};

// A chamber's own passage action names it ("Passed/agreed to in Senate",
// "Passed House with an amendment"); "Received in the House" is the House
// confirming the bill arrived after the *Senate* passed it, so it credits the
// other chamber. Bare "agreed to" is left alone — amendments are "agreed to" too.
const PASSED_IN_RE = /\b(?:passed\/agreed to|resolution agreed to) in (?:the )?(house|senate)\b|^passed (house|senate)\b/i;
const RECEIVED_IN_RE = /\breceived in the (house|senate)\b/i;
const PRESENTED_RE = /\bpresented to (?:the )?president\b/i;
const BECAME_LAW_RE = /\bbecame (?:public|private) law\b|\bsigned by (?:the )?president\b/i;

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

// Folds one action into the running set of stages a bill has reached. Exported
// so the tooltip can classify a bill's latestAction alone while the full history
// is still loading.
function recordBillStage(stages, action) {
  const text = action?.text || "";
  const passedIn = text.match(PASSED_IN_RE);
  if (passedIn) stages.passed.add(capitalize(passedIn[1] || passedIn[2]));
  const received = text.match(RECEIVED_IN_RE);
  if (received) stages.passed.add(received[1].toLowerCase() === "house" ? "Senate" : "House");
  if (action?.type === "President" || PRESENTED_RE.test(text)) stages.president = true;
  if (action?.type === "BecameLaw" || BECAME_LAW_RE.test(text)) stages.law = true;
  return stages;
}

function emptyBillStages() {
  return { passed: new Set(), president: false, law: false };
}

// The sponsored-legislation list only carries `latestAction`, so which chambers
// a bill cleared needs its full action history, one request per bill.
async function getBillChamberPassage(bill) {
  if (!(bill?.congress && bill?.type && bill?.number != null)) return;
  const path = `bill/${bill.congress}/${String(bill.type).toLowerCase()}/${bill.number}/actions`;

  const stages = emptyBillStages();
  for await (const page of paginate(path, { limit: 250 })) {
    for (const action of coerceList(page.actions)) recordBillStage(stages, action);
    // Becoming law is the last stage, so nothing further back can change it.
    if (stages.law) break;
  }

  bill._stages = stages;
  bill._chamber = CHAMBER_BY_TYPE[String(bill.type).toUpperCase()] || "";
}

// Runs a bounded number of these at once — one request per bill would otherwise
// mean dozens of concurrent fetches for a busy sponsor.
async function getBillsChamberPassage(bills, concurrency = 6) {
  const refs = bills.filter((b) => b?.congress && b?.type && b?.number != null);
  let i = 0;
  const worker = async () => {
    while (i < refs.length) {
      const bill = refs[i++];
      await getBillChamberPassage(bill).catch((err) => {
        console.error(`bill actions failed for ${billKey(bill)}: ${err?.message ?? err}`);
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, refs.length) }, worker));
  return { checked: refs.length };
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

export { getMemberDetails, getSponsoredLegislation, getBillDescriptions, getBillsChamberPassage, recordBillStage, emptyBillStages, CHAMBER_BY_TYPE, countBillsByPolicyArea, searchMembers };
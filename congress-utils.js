const WORKER_URL = "https://congress-api-cache.alissa-wang.workers.dev";

import { coerceList } from "./utils.js";

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

async function getSponsoredLegislation(bioguideId) {
  const out = [];
  const listPath = `/member/${bioguideId}/sponsored-legislation`;

  for await (const page of paginate(listPath, { limit: 250 })) {
    const items =
      coerceList(page.sponsoredLegislation) ||
      coerceList(page.results) ||
      coerceList(page.items);
    out.push(...items);
  }
  return out;
}

async function countBillsByPolicyArea(congress_session_num) {
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

export { getMemberDetails, getSponsoredLegislation, countBillsByPolicyArea, searchMembers };
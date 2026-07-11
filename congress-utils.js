const CONGRESS_API_KEY = "DZFgdKtmBuYdw7GXAMWpaPJ4IgoOmSmh0cDxLKFP";
const BASE_URL = "https://api.congress.gov/v3";

import { coerceList } from "./utils.js";

async function getJson(path, params = {}) {
  const url = new URL(`${BASE_URL}/${path.replace(/^\/+/, "")}`);
  url.searchParams.set("api_key", CONGRESS_API_KEY);
  url.searchParams.set("format", "json");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, { headers: { "User-Agent": "congressgov-bills/1.0" } });
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

function wasInHouse(member, startYear, endYear) {
  return member.terms.item.some(term =>
    term.chamber === "House of Representatives" &&
    (term.startYear <= endYear) &&
    (term.endYear == null || term.endYear >= startYear)
  );
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
  const yamlPath = `./cached_api_calls/congress${congress_session_num}BillCounts.yaml`;
  try {
    const res = await fetch(yamlPath);
    if (res.ok) {
      const text = await res.text();
      const counts = Object.fromEntries(
        text.trim().split("\n")
          .map(line => line.match(/^(.+?):\s*(\d+)$/))
          .filter(Boolean)
          .map(([, key, val]) => [key, Number(val)])
      );
      console.log(`Bill counts by policy area retrieved from cache for Congress ${congress_session_num}`);
      return counts;
    }
  } catch {}

  const allCongressMembers = [];
  for await (const page of paginate(`/member/congress/${congress_session_num}`)) {
    allCongressMembers.push(...(page.members ?? []));
  }

  const session = await getJson(`/congress/${congress_session_num}`);
  const sessionStart = session.congress.startYear
  const sessionEnd = session.congress.endYear
  const activeHouseMembers = allCongressMembers.filter(m => wasInHouse(m, sessionStart, sessionEnd));
  console.log(`Found ${activeHouseMembers.length} House members for Congress ${congress_session_num}.`);
  
  const policyAreaCounts = {};
  for (let i = 0; i < activeHouseMembers.length; i++) {
    const { bioguideId } = activeHouseMembers[i];
    
    try {
      let memberBills = await getSponsoredLegislation(bioguideId);
      let filteredMemberBills = memberBills.filter(bill => bill.congress === congress_session_num && bill.title);
      for (const bill of filteredMemberBills) {
        const policyAreaName = bill.policyArea?.name ?? "Other";
        policyAreaCounts[policyAreaName] = (policyAreaCounts[policyAreaName] ?? 0) + 1;
      }
    } catch (err) {
      console.warn(`Failed to fetch bills for member ${bioguideId}:`, err.message);
    }

    if ((i + 1) % 20 === 0) {
      console.log(`Processed ${i + 1} members...`);
      console.log("Current policy area counts:", policyAreaCounts);
    }
  }

  return policyAreaCounts
}



export { getSponsoredLegislation, countBillsByPolicyArea };
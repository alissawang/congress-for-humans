const WORKER_URL = "https://api.congressforhumans.com";

import { makePrimaryName, billKey } from "./utils.js";

// Summarizes the description getBillDescriptions resolved for each bill — a CRS
// summary, or the bill's own titles led by its official purpose clause. Bills it
// could describe from neither are skipped rather than summarized from a bare
// name, since condensing a name would mean inventing the contents.
async function summarizeBillsWithClaude(bills) {
  const items = bills
    .filter((bill) => bill._description?.text)
    .map((bill) => ({
      id: billKey(bill),
      text: bill._description.text,
      source: bill._description.source,
    }));
  if (!items.length) return;

  const res = await fetch(`${WORKER_URL}/summarize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bills: items }),
  });
  if (!res.ok) return;

  const { summaries } = await res.json();
  for (const bill of bills) {
    const summary = summaries?.[billKey(bill)];
    if (summary) bill._summary = String(summary);
  }
}

// Must match fingerprintAreas in src/worker.js byte for byte, normalization
// included. That's what lets a lookup by GET find the entry the POST stored.
async function fingerprintAreas(areas) {
  const canonical = JSON.stringify(areas.map((a) => [a.category, a.bills]));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Asks first by GET, which the browser can cache across reloads. Only if the
// worker has never labelled this exact bill list does it POST the list for
// Claude to label.
async function getFocusAreas(bioguideId, year, groups) {
  // Normalized the same way the worker normalizes the POST body, so both sides
  // fingerprint the same list.
  const areas = groups
    .map((g) => ({
      category: g.category,
      bills: g.bills
        .map((bill) => bill.description || bill.title || makePrimaryName(bill))
        .filter((t) => typeof t === "string" && t),
    }))
    .filter((a) => a.bills.length > 0);
  if (!areas.length) return {};

  try {
    const lookup = new URL(`${WORKER_URL}/focus-areas`);
    lookup.searchParams.set("bioguideId", bioguideId);
    lookup.searchParams.set("year", String(year));
    lookup.searchParams.set("fp", await fingerprintAreas(areas));
    const hit = await fetch(lookup);
    if (hit.ok) {
      const { areas: cached } = await hit.json();
      if (cached) return cached;
    }
  } catch (err) {
    // The lookup only saves time. If it fails, generating is still the answer.
    console.error(`focus-areas lookup failed: ${err?.message ?? err}`);
  }

  const res = await fetch(`${WORKER_URL}/focus-areas`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bioguideId, year, areas }),
  });
  if (!res.ok) return {};

  const { areas: areaTexts } = await res.json();
  return areaTexts || {};
}

export { summarizeBillsWithClaude, getFocusAreas };

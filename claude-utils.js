const WORKER_URL = "https://congress-api-cache.alissa-wang.workers.dev";

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

// The id a bill's shared label is stored under. Type is uppercased because the
// sponsored and vote feeds don't promise the same casing; a bill missing any
// part gets no id (which sends its whole request down the per-list path).
function labelId(bill) {
  if (!bill?.congress || !bill?.type || bill?.number == null) return "";
  return `${bill.congress}-${String(bill.type).toUpperCase()}-${bill.number}`;
}

// `subject` is "sponsored" (the default) or "voted": which list these bills are,
// so the prompt describes them correctly. `ids` lets the worker give each bill
// the one label it has everywhere — sponsored or voted on, any member — instead
// of a fresh one per list. Sent beside `bills` rather than in place of them, so
// a worker that predates ids still reads the request.
async function getFocusAreas(bioguideId, year, groups, { subject } = {}) {
  const areas = groups.map((g) => ({
    category: g.category,
    bills: g.bills.map((bill) => bill.description || bill.title || makePrimaryName(bill)),
    ids: g.bills.map(labelId),
  }));

  const res = await fetch(`${WORKER_URL}/focus-areas`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bioguideId, year, areas, ...(subject ? { subject } : {}) }),
  });
  if (!res.ok) return {};

  const { areas: areaTexts } = await res.json();
  return areaTexts || {};
}

export { summarizeBillsWithClaude, getFocusAreas };

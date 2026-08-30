const WORKER_URL = "https://congress-api-cache.alissa-wang.workers.dev";

import { makePrimaryName } from "./utils.js";

function billKey(bill) {
  return `${bill.congress}-${bill.type}-${bill.number}`;
}

async function summarizeBillsWithClaude(bills) {
  const items = bills.map((bill) => ({
    id: billKey(bill),
    text: bill.description || bill.title || makePrimaryName(bill),
  }));

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

async function getFocusAreas(bioguideId, year, groups) {
  const areas = groups.map((g) => ({
    category: g.category,
    bills: g.bills.map((bill) => bill.description || bill.title || makePrimaryName(bill)),
  }));

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

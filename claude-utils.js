const CLAUDE_API_KEY = "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";

import { makePrimaryName } from "./utils.js";

async function hashInput(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function loadCache(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    // quota exceeded — skip silently
  }
}

function applySummaries(summaryMap, bills) {
  for (const [idx, summary] of Object.entries(summaryMap)) {
    const bill = bills[Number(idx)];
    if (bill) bill._summary = String(summary);
  }
}

async function summarizeBillsWithClaude(bills) {
  const lines = bills.map((bill, i) => {
    const text = bill.description || bill.title || makePrimaryName(bill);
    return `[${i}] ${text}`;
  });

  const inputStr = lines.join("\n");
  const hash = await hashInput(inputStr);
  const cacheKey = `bills-sum-${hash}`;
  const cached = loadCache(cacheKey);
  if (cached) { applySummaries(cached, bills); return; }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: [
        {
          role: "user",
          content:
            lines.join("\n") +
            '\n\nSummarize each bill in one sentence in the format "[goal of bill] by [mechanism]." Return a JSON object where each key is the bill\'s index number (as a string) and each value is its one-sentence summary.',
        },
      ],
    }),
  });

  if (!res.ok) return;

  const data = await res.json();
  const text = data.content?.[0]?.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return;

  const summaryMap = JSON.parse(jsonMatch[0]);
  saveCache(cacheKey, summaryMap);
  applySummaries(summaryMap, bills);
}

export { summarizeBillsWithClaude };

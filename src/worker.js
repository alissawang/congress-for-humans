const DEFAULT_TTL_SECONDS = 60 * 60 * 24; // 1 day
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function getCacheKey(url) {
  const path = url.searchParams.get("path") || "";
  const params = new URLSearchParams(url.searchParams);
  params.delete("path");
  params.delete("ttl");
  params.sort();
  return `${path}?${params.toString()}`;
}

function buildInternalUrl(path, paramsObj) {
  const url = new URL("https://internal/");
  url.searchParams.set("path", path);
  for (const [k, v] of Object.entries(paramsObj)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return url;
}

async function fetchCongressJson(path, paramsObj, env) {
  const cacheKey = getCacheKey(buildInternalUrl(path, paramsObj));
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const apiKey = env.CONGRESS_API_KEY;
  if (!apiKey) throw new Error("Missing CONGRESS_API_KEY secret");

  const upstreamUrl = new URL(`https://api.congress.gov/v3/${path.replace(/^\/+/, "")}`);
  upstreamUrl.searchParams.set("api_key", apiKey);
  upstreamUrl.searchParams.set("format", "json");
  for (const [k, v] of Object.entries(paramsObj)) {
    if (v !== undefined && v !== null) upstreamUrl.searchParams.set(k, String(v));
  }

  const res = await fetch(upstreamUrl, { headers: { "User-Agent": "congressgov-bills/1.0" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Congress API ${res.status}: ${text.slice(0, 200)}`);

  await env.CACHE.put(cacheKey, text, { expirationTtl: DEFAULT_TTL_SECONDS });
  return JSON.parse(text);
}

async function paginateCongress(path, paramsObj, env, extractItems) {
  let offset = 0;
  const limit = 250;
  const out = [];
  while (true) {
    const page = await fetchCongressJson(path, { ...paramsObj, offset, limit }, env);
    out.push(...extractItems(page));
    if (!page?.pagination?.next) break;
    offset += limit;
  }
  return out;
}

const MEMBER_FETCH_CONCURRENCY = 40;

async function mapWithConcurrency(items, limit, fn) {
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function wasInHouse(member, startYear, endYear) {
  return member.terms.item.some(
    (term) =>
      term.chamber === "House of Representatives" &&
      term.startYear <= endYear &&
      (term.endYear == null || term.endYear >= startYear)
  );
}

async function handleBillCounts(url, env) {
  const congressNum = Number(url.searchParams.get("congress"));
  if (!Number.isInteger(congressNum) || congressNum <= 0) {
    return new Response("Missing or invalid congress query parameter", {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  const cacheKey = `bill-counts:${congressNum}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached) {
    return new Response(cached, {
      status: 200,
      headers: { "content-type": "application/json", "x-cache": "hit", ...CORS_HEADERS },
    });
  }

  try {
    const members = await paginateCongress(
      `member/congress/${congressNum}`,
      {},
      env,
      (page) => page.members ?? []
    );

    const session = await fetchCongressJson(`congress/${congressNum}`, {}, env);
    const sessionStart = session.congress.startYear;
    const sessionEnd = session.congress.endYear;
    const activeHouseMembers = members.filter((m) => wasInHouse(m, sessionStart, sessionEnd));

    const policyAreaCounts = {};
    await mapWithConcurrency(activeHouseMembers, MEMBER_FETCH_CONCURRENCY, async (member) => {
      try {
        const bills = await paginateCongress(
          `member/${member.bioguideId}/sponsored-legislation`,
          {},
          env,
          (page) => page.sponsoredLegislation ?? page.results ?? page.items ?? []
        );
        for (const bill of bills) {
          if (bill.congress !== congressNum || !bill.title) continue;
          const name = bill.policyArea?.name ?? "Other";
          policyAreaCounts[name] = (policyAreaCounts[name] ?? 0) + 1;
        }
      } catch {
        // skip members whose sponsored-legislation fetch failed; a retry will pick them up
      }
    });

    const responseText = JSON.stringify(policyAreaCounts);
    await env.CACHE.put(cacheKey, responseText, { expirationTtl: DEFAULT_TTL_SECONDS });

    return new Response(responseText, {
      status: 200,
      headers: { "content-type": "application/json", "x-cache": "miss", ...CORS_HEADERS },
    });
  } catch (err) {
    return new Response(`Failed to compute bill counts: ${err.message}`, {
      status: 502,
      headers: CORS_HEADERS,
    });
  }
}

const SUMMARIZE_BATCH_SIZE = 20;

async function summarizeBatch(batch, apiKey) {
  const lines = batch.map((b, i) => `[${i}] ${b.text}`);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
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

  if (!res.ok) return {};

  const data = await res.json();
  const text = data.content?.[0]?.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return {};

  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return {};
  }
}

async function handleSummarize(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400, headers: CORS_HEADERS });
  }

  const bills = Array.isArray(body?.bills) ? body.bills : [];
  const validBills = bills.filter((b) => b && typeof b.id === "string" && typeof b.text === "string");

  const summaries = {};
  const cacheResults = await Promise.all(
    validBills.map((b) => env.CACHE.get(`summary:${b.id}`))
  );

  const misses = [];
  validBills.forEach((b, i) => {
    if (cacheResults[i]) {
      summaries[b.id] = cacheResults[i];
    } else {
      misses.push(b);
    }
  });

  if (misses.length > 0) {
    const apiKey = env.CLAUDE_API_KEY;
    if (!apiKey) {
      return new Response("Missing CLAUDE_API_KEY secret", { status: 500, headers: CORS_HEADERS });
    }

    const batches = [];
    for (let i = 0; i < misses.length; i += SUMMARIZE_BATCH_SIZE) {
      batches.push(misses.slice(i, i + SUMMARIZE_BATCH_SIZE));
    }

    const puts = [];
    await Promise.all(
      batches.map(async (batch) => {
        let summaryMap = {};
        try {
          summaryMap = await summarizeBatch(batch, apiKey);
        } catch {
          return;
        }
        for (const [idx, summary] of Object.entries(summaryMap)) {
          const bill = batch[Number(idx)];
          if (!bill) continue;
          const summaryText = String(summary);
          summaries[bill.id] = summaryText;
          puts.push(env.CACHE.put(`summary:${bill.id}`, summaryText));
        }
      })
    );
    await Promise.all(puts);
  }

  return new Response(JSON.stringify({ summaries }), {
    status: 200,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }

    if (url.pathname === "/summarize") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
      }
      return handleSummarize(request, env);
    }

    if (url.pathname === "/bill-counts") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
      }
      return handleBillCounts(url, env);
    }

    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
    }

    const path = url.searchParams.get("path");
    if (!path) {
      return new Response("Missing required query parameter: path", {
        status: 400,
        headers: CORS_HEADERS,
      });
    }

    const cacheKey = getCacheKey(url);

    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      return new Response(cached, {
        status: 200,
        headers: { "content-type": "application/json", "x-cache": "hit", ...CORS_HEADERS },
      });
    }

    const apiKey = env.CONGRESS_API_KEY;
    if (!apiKey) {
      return new Response("Missing CONGRESS_API_KEY secret", { status: 500, headers: CORS_HEADERS });
    }

    const upstreamUrl = new URL(`https://api.congress.gov/v3/${path.replace(/^\/+/, "")}`);
    upstreamUrl.searchParams.set("api_key", apiKey);
    upstreamUrl.searchParams.set("format", "json");
    for (const [key, value] of url.searchParams.entries()) {
      if (key !== "path" && key !== "ttl") upstreamUrl.searchParams.set(key, value);
    }

    const upstreamResponse = await fetch(upstreamUrl, {
      headers: { "User-Agent": "congressgov-bills/1.0" },
    });

    const responseText = await upstreamResponse.text();
    if (!upstreamResponse.ok) {
      return new Response(responseText, {
        status: upstreamResponse.status,
        headers: {
          "content-type": upstreamResponse.headers.get("content-type") || "text/plain",
          ...CORS_HEADERS,
        },
      });
    }

    const ttlSeconds = Math.max(60, Number(url.searchParams.get("ttl")) || DEFAULT_TTL_SECONDS);
    await env.CACHE.put(cacheKey, responseText, { expirationTtl: ttlSeconds });

    return new Response(responseText, {
      status: 200,
      headers: { "content-type": "application/json", "x-cache": "miss", ...CORS_HEADERS },
    });
  },
};

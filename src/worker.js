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

const MAX_UPSTREAM_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCongressJson(path, paramsObj, env, { ttlSeconds } = {}) {
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

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(upstreamUrl, { headers: { "User-Agent": "congressgov-bills/1.0" } });
    if (res.ok) {
      const text = await res.text();
      const putOptions = ttlSeconds != null ? { expirationTtl: ttlSeconds } : undefined;
      await env.CACHE.put(cacheKey, text, putOptions);
      return JSON.parse(text);
    }

    const text = await res.text();
    const retryable = (res.status === 429 || res.status >= 500) && attempt < MAX_UPSTREAM_RETRIES;
    if (!retryable) throw new Error(`Congress API ${res.status}: ${text.slice(0, 200)}`);

    const retryAfterSecs = Number(res.headers.get("retry-after"));
    const backoffMs = Number.isFinite(retryAfterSecs) && retryAfterSecs > 0
      ? retryAfterSecs * 1000
      : RETRY_BASE_DELAY_MS * 2 ** attempt;
    console.error(`Congress API ${res.status} on ${path} (attempt ${attempt + 1}); retrying in ${backoffMs}ms`);
    await sleep(backoffMs + Math.random() * backoffMs * 0.25);
  }
}

async function paginateCongress(path, paramsObj, env, extractItems, { ttlSeconds } = {}) {
  let offset = 0;
  const limit = 250;
  const out = [];
  while (true) {
    const page = await fetchCongressJson(path, { ...paramsObj, offset, limit }, env, { ttlSeconds });
    out.push(...extractItems(page));
    if (!page?.pagination?.next) break;
    offset += limit;
  }
  return out;
}

const MEMBER_FETCH_CONCURRENCY = 8;
const CURRENT_CONGRESS_REFRESH_SECONDS = 60 * 60 * 6; // 6 hours
const REVALIDATE_LOCK_TTL_SECONDS = 60 * 15; // 15 min best-effort lock

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

function isCurrentCongressSession(startYear, endYear) {
  const nowYear = new Date().getFullYear();
  return startYear <= nowYear && (endYear == null || endYear >= nowYear);
}

function normalizeMember(m) {
  const lastTerm = m.terms?.item?.[m.terms.item.length - 1];
  return {
    bioguideId: m.bioguideId,
    name: m.name,
    state: m.state,
    district: m.district ?? null,
    partyName: m.partyName,
    chamber: lastTerm?.chamber ?? null,
    imageUrl: m.depiction?.imageUrl ?? null,
  };
}

async function computeMemberRoster(congressNum, env) {
  // Session start/end years are immutable, so this lookup is always cached forever.
  const session = await fetchCongressJson(`congress/${congressNum}`, {}, env);
  const isCurrent = isCurrentCongressSession(session.congress.startYear, session.congress.endYear);
  const rawTtl = isCurrent ? CURRENT_CONGRESS_REFRESH_SECONDS : undefined;

  // currentMember=false per the API docs' guidance for getting the complete
  // roster of everyone who served in this Congress, not just those still serving.
  const members = await paginateCongress(
    `member/congress/${congressNum}`,
    { currentMember: false },
    env,
    (page) => page.members ?? [],
    { ttlSeconds: rawTtl }
  );
  return members.map(normalizeMember);
}

async function persistMemberRoster(env, cacheKey, roster) {
  const entry = JSON.stringify({ members: roster, computedAt: Date.now() });
  await env.CACHE.put(cacheKey, entry);
}

async function revalidateMemberRoster(congressNum, env, cacheKey, lockKey) {
  const lockHeld = await env.CACHE.get(lockKey);
  if (lockHeld) return;
  await env.CACHE.put(lockKey, "1", { expirationTtl: REVALIDATE_LOCK_TTL_SECONDS });

  try {
    const roster = await computeMemberRoster(congressNum, env);
    await persistMemberRoster(env, cacheKey, roster);
  } catch (err) {
    console.error(`background member-roster revalidation failed for congress ${congressNum}: ${err.message}`);
  }
}

async function getMemberRoster(congressNum, env, ctx) {
  const cacheKey = `member-roster:${congressNum}`;
  const lockKey = `member-roster-lock:${congressNum}`;
  const cachedRaw = await env.CACHE.get(cacheKey);

  if (cachedRaw) {
    const parsed = JSON.parse(cachedRaw);
    let stale = false;
    try {
      const session = await fetchCongressJson(`congress/${congressNum}`, {}, env);
      const isCurrent = isCurrentCongressSession(session.congress.startYear, session.congress.endYear);
      stale = isCurrent && (Date.now() - parsed.computedAt) / 1000 > CURRENT_CONGRESS_REFRESH_SECONDS;
    } catch (err) {
      console.error(`current-congress check failed for congress ${congressNum}: ${err.message}`);
    }

    if (stale) ctx.waitUntil(revalidateMemberRoster(congressNum, env, cacheKey, lockKey));
    return parsed.members;
  }

  const roster = await computeMemberRoster(congressNum, env);
  await persistMemberRoster(env, cacheKey, roster);
  return roster;
}

async function resolveCurrentCongressNumber(env) {
  const page = await fetchCongressJson("congress", { limit: 1 }, env, { ttlSeconds: DEFAULT_TTL_SECONDS });
  const match = page?.congresses?.[0]?.url?.match(/\/congress\/(\d+)/);
  if (!match) throw new Error("Could not determine current Congress number");
  return Number(match[1]);
}

function filterMembers(members, { q, state, district }) {
  const query = q?.trim().toLowerCase();
  const stateQuery = state?.trim().toLowerCase();
  const districtQuery = district?.trim();

  return members.filter((m) => {
    if (query && !m.name.toLowerCase().includes(query)) return false;
    if (stateQuery && m.state?.toLowerCase() !== stateQuery) return false;
    if (districtQuery && String(m.district ?? "") !== districtQuery) return false;
    return true;
  });
}

async function handleMemberSearch(url, env, ctx) {
  const congressParam = url.searchParams.get("congress");
  let congressNum;
  try {
    congressNum = congressParam ? Number(congressParam) : await resolveCurrentCongressNumber(env);
  } catch (err) {
    return new Response(`Failed to resolve Congress number: ${err.message}`, { status: 502, headers: CORS_HEADERS });
  }
  if (!Number.isInteger(congressNum) || congressNum <= 0) {
    return new Response("Invalid congress query parameter", { status: 400, headers: CORS_HEADERS });
  }

  try {
    const roster = await getMemberRoster(congressNum, env, ctx);
    const results = filterMembers(roster, {
      q: url.searchParams.get("q"),
      state: url.searchParams.get("state"),
      district: url.searchParams.get("district"),
    });
    return new Response(JSON.stringify({ congress: congressNum, count: results.length, members: results }), {
      status: 200,
      headers: { "content-type": "application/json", ...CORS_HEADERS },
    });
  } catch (err) {
    return new Response(`Failed to search members: ${err.message}`, { status: 502, headers: CORS_HEADERS });
  }
}

async function computeBillCounts(congressNum, env) {
  // Session start/end years are immutable regardless of whether the congress is
  // still active, so this lookup is always cached forever (no ttlSeconds).
  const session = await fetchCongressJson(`congress/${congressNum}`, {}, env);
  const sessionStart = session.congress.startYear;
  const sessionEnd = session.congress.endYear;
  const isCurrent = isCurrentCongressSession(sessionStart, sessionEnd);
  const rawTtl = isCurrent ? CURRENT_CONGRESS_REFRESH_SECONDS : undefined;

  const members = await paginateCongress(
    `member/congress/${congressNum}`,
    {},
    env,
    (page) => page.members ?? [],
    { ttlSeconds: rawTtl }
  );
  const activeHouseMembers = members.filter((m) => wasInHouse(m, sessionStart, sessionEnd));

  const policyAreaCounts = {};
  let failedMembers = 0;
  await mapWithConcurrency(activeHouseMembers, MEMBER_FETCH_CONCURRENCY, async (member) => {
    try {
      const bills = await paginateCongress(
        `member/${member.bioguideId}/sponsored-legislation`,
        {},
        env,
        (page) => page.sponsoredLegislation ?? page.results ?? page.items ?? [],
        { ttlSeconds: rawTtl }
      );
      for (const bill of bills) {
        if (bill.congress !== congressNum || !bill.title) continue;
        const name = bill.policyArea?.name ?? "Other";
        policyAreaCounts[name] = (policyAreaCounts[name] ?? 0) + 1;
      }
    } catch (err) {
      failedMembers++;
      console.error(`sponsored-legislation fetch failed for member ${member.bioguideId}: ${err.message}`);
    }
  });

  return { policyAreaCounts, failedMembers, activeMemberCount: activeHouseMembers.length };
}

async function persistBillCountsIfComplete(congressNum, env, cacheKey, result) {
  // Only cache a complete result — caching a partial (some members failed) result
  // would lock in an undercount, since later requests would be served straight
  // from cache instead of recomputing.
  if (result.failedMembers === 0) {
    const entry = JSON.stringify({ counts: result.policyAreaCounts, computedAt: Date.now() });
    // No expirationTtl, ever: past-congress data is immutable, and current-congress
    // staleness is judged by `computedAt` on read, not by KV expiry — we always
    // want something in cache to serve.
    await env.CACHE.put(cacheKey, entry);
  } else {
    console.error(
      `bill-counts for congress ${congressNum}: ${result.failedMembers}/${result.activeMemberCount} member fetches failed; not caching`
    );
  }
}

async function revalidateBillCounts(congressNum, env, cacheKey, lockKey) {
  // Best-effort de-dup only — Workers KV has no atomic compare-and-swap, so two
  // requests can both read "no lock" and both proceed. Acceptable here given low
  // traffic; both racing writers still go through the failedMembers===0 gate above.
  const lockHeld = await env.CACHE.get(lockKey);
  if (lockHeld) return;
  await env.CACHE.put(lockKey, "1", { expirationTtl: REVALIDATE_LOCK_TTL_SECONDS });

  try {
    const result = await computeBillCounts(congressNum, env);
    await persistBillCountsIfComplete(congressNum, env, cacheKey, result);
  } catch (err) {
    console.error(`background revalidation failed for congress ${congressNum}: ${err.message}`);
  }
}

async function handleBillCounts(url, env, ctx) {
  const congressNum = Number(url.searchParams.get("congress"));
  if (!Number.isInteger(congressNum) || congressNum <= 0) {
    return new Response("Missing or invalid congress query parameter", {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  const cacheKey = `bill-counts:${congressNum}`;
  const lockKey = `bill-counts-lock:${congressNum}`;
  const cachedRaw = await env.CACHE.get(cacheKey);

  if (cachedRaw) {
    const parsed = JSON.parse(cachedRaw);
    // Entries written before the {counts, computedAt} wrapper was introduced are a
    // flat {policyArea: count} object with no `.counts` property — treat those as
    // maximally stale so they get revalidated into the new format in the background,
    // instead of serving `undefined` as the response body.
    const legacyFormat = parsed.counts === undefined;
    const counts = legacyFormat ? parsed : parsed.counts;
    const computedAt = legacyFormat ? 0 : parsed.computedAt;

    let stale = legacyFormat;
    try {
      const session = await fetchCongressJson(`congress/${congressNum}`, {}, env);
      const isCurrent = isCurrentCongressSession(session.congress.startYear, session.congress.endYear);
      const ageSeconds = (Date.now() - computedAt) / 1000;
      stale = stale || (isCurrent && ageSeconds > CURRENT_CONGRESS_REFRESH_SECONDS);
    } catch (err) {
      // Don't let a staleness-check hiccup jeopardize serving the cached value.
      console.error(`current-congress check failed for congress ${congressNum}: ${err.message}`);
    }

    if (stale) {
      ctx.waitUntil(revalidateBillCounts(congressNum, env, cacheKey, lockKey));
    }

    return new Response(JSON.stringify(counts), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-cache": "hit",
        ...(stale ? { "x-cache-status": "stale" } : {}),
        ...CORS_HEADERS,
      },
    });
  }

  try {
    const result = await computeBillCounts(congressNum, env);
    await persistBillCountsIfComplete(congressNum, env, cacheKey, result);

    return new Response(JSON.stringify(result.policyAreaCounts), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-cache": "miss",
        ...(result.failedMembers > 0 ? { "x-partial-failures": String(result.failedMembers) } : {}),
        ...CORS_HEADERS,
      },
    });
  } catch (err) {
    return new Response(`Failed to compute bill counts: ${err.message}`, {
      status: 502,
      headers: CORS_HEADERS,
    });
  }
}

const SUMMARIZE_BATCH_SIZE = 20;
const MAX_SUMMARY_RETRIES = 4;
const SUMMARY_RETRY_BASE_DELAY_MS = 500;
const SUMMARY_BATCH_CONCURRENCY = 4;

async function summarizeBatch(batch, apiKey) {
  const lines = batch.map((b, i) => `[${i}] ${b.text}`);
  const body = JSON.stringify({
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
  });

  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body,
    });

    if (res.ok) {
      const data = await res.json();
      const text = data.content?.[0]?.text || "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? tryParseJson(jsonMatch[0]) : null;
      if (parsed) return parsed;

      // Claude's output is non-deterministic, so an unparseable completion is worth retrying.
      if (attempt >= MAX_SUMMARY_RETRIES) {
        console.error(`summarizeBatch: unparseable completion after ${attempt + 1} attempt(s), giving up. Raw text: ${text.slice(0, 200)}`);
        return {};
      }
      const backoffMs = SUMMARY_RETRY_BASE_DELAY_MS * 2 ** attempt;
      console.error(`summarizeBatch: unparseable completion (attempt ${attempt + 1}); retrying in ${backoffMs}ms`);
      await sleep(backoffMs + Math.random() * backoffMs * 0.25);
      continue;
    }

    const text = await res.text();
    const retryable = (res.status === 429 || res.status >= 500) && attempt < MAX_SUMMARY_RETRIES;
    if (!retryable) {
      console.error(`summarizeBatch: Anthropic API ${res.status} after ${attempt + 1} attempt(s), giving up: ${text.slice(0, 200)}`);
      return {};
    }

    const retryAfterSecs = Number(res.headers.get("retry-after"));
    const backoffMs = Number.isFinite(retryAfterSecs) && retryAfterSecs > 0
      ? retryAfterSecs * 1000
      : SUMMARY_RETRY_BASE_DELAY_MS * 2 ** attempt;
    console.error(`summarizeBatch: Anthropic API ${res.status} (attempt ${attempt + 1}); retrying in ${backoffMs}ms`);
    await sleep(backoffMs + Math.random() * backoffMs * 0.25);
  }
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function generateFocusAreas(year, areas, apiKey) {
  const sections = areas
    .map((a) => `[${a.category}]\n` + a.bills.map((t, i) => `${i + 1}. ${t}`).join("\n"))
    .join("\n\n");

  const body = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    messages: [
      {
        role: "user",
        content:
          `Here are bills a member of Congress sponsored in ${year}, grouped by policy area:\n\n${sections}\n\n` +
          "For each policy area listed above, write a short label (a few words, not a full sentence) for " +
          "EVERY bill listed in that area — not a generic restatement of the policy area's name. Every bill " +
          "number must get exactly one label; do not skip any or combine multiple bills into one label. " +
          "Each label will be displayed lowercase mid-sentence, so do NOT capitalize the first word unless " +
          'it is a proper noun or acronym (e.g. "wildlife corridors", "AI guardrails", "Medicare cuts", ' +
          '"ESA override"). Return a JSON object where each key is the policy area name exactly as given in ' +
          'brackets above, and each value is an array of objects like {"bill": <the bill\'s number from the ' +
          'list above>, "label": <short label string>}, one per bill. The shorter the better: keep each ' +
          "label to just a few words, since all the labels for a policy area, joined with \", \", must fit " +
          "on a single line in the UI.",
      },
    ],
  });

  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body,
    });

    if (res.ok) {
      const data = await res.json();
      const text = data.content?.[0]?.text || "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? tryParseJson(jsonMatch[0]) : null;
      if (parsed) return parsed;

      if (attempt >= MAX_SUMMARY_RETRIES) {
        console.error(`generateFocusAreas: unparseable completion after ${attempt + 1} attempt(s), giving up. Raw text: ${text.slice(0, 200)}`);
        return {};
      }
      const backoffMs = SUMMARY_RETRY_BASE_DELAY_MS * 2 ** attempt;
      console.error(`generateFocusAreas: unparseable completion (attempt ${attempt + 1}); retrying in ${backoffMs}ms`);
      await sleep(backoffMs + Math.random() * backoffMs * 0.25);
      continue;
    }

    const text = await res.text();
    const retryable = (res.status === 429 || res.status >= 500) && attempt < MAX_SUMMARY_RETRIES;
    if (!retryable) {
      console.error(`generateFocusAreas: Anthropic API ${res.status} after ${attempt + 1} attempt(s), giving up: ${text.slice(0, 200)}`);
      return {};
    }

    const retryAfterSecs = Number(res.headers.get("retry-after"));
    const backoffMs = Number.isFinite(retryAfterSecs) && retryAfterSecs > 0
      ? retryAfterSecs * 1000
      : SUMMARY_RETRY_BASE_DELAY_MS * 2 ** attempt;
    console.error(`generateFocusAreas: Anthropic API ${res.status} (attempt ${attempt + 1}); retrying in ${backoffMs}ms`);
    await sleep(backoffMs + Math.random() * backoffMs * 0.25);
  }
}

async function handleFocusAreas(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400, headers: CORS_HEADERS });
  }

  const bioguideId = typeof body?.bioguideId === "string" ? body.bioguideId : "";
  const year = Number(body?.year);
  const areas = Array.isArray(body?.areas)
    ? body.areas
        .filter((a) => a && typeof a.category === "string" && Array.isArray(a.bills))
        .map((a) => ({ category: a.category, bills: a.bills.filter((t) => typeof t === "string" && t) }))
        .filter((a) => a.bills.length > 0)
    : [];

  if (!bioguideId || !Number.isInteger(year) || areas.length === 0) {
    return new Response("Missing bioguideId, year, or areas", { status: 400, headers: CORS_HEADERS });
  }

  const cacheKey = `focus-areas:${bioguideId}:${year}`;
  const cached = await env.SUMMARY_CACHE.get(cacheKey);
  if (cached) {
    return new Response(JSON.stringify({ areas: JSON.parse(cached) }), {
      status: 200,
      headers: { "content-type": "application/json", ...CORS_HEADERS },
    });
  }

  const apiKey = env.CLAUDE_API_KEY;
  if (!apiKey) {
    return new Response("Missing CLAUDE_API_KEY secret", { status: 500, headers: CORS_HEADERS });
  }

  const areaTexts = await generateFocusAreas(year, areas, apiKey);
  if (Object.keys(areaTexts).length > 0) {
    await env.SUMMARY_CACHE.put(cacheKey, JSON.stringify(areaTexts));
  }

  return new Response(JSON.stringify({ areas: areaTexts }), {
    status: 200,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
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
    validBills.map((b) => env.SUMMARY_CACHE.get(`summary:${b.id}`))
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
    await mapWithConcurrency(batches, SUMMARY_BATCH_CONCURRENCY, async (batch) => {
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
        puts.push(env.SUMMARY_CACHE.put(`summary:${bill.id}`, summaryText));
      }
    });
    await Promise.all(puts);
  }

  return new Response(JSON.stringify({ summaries }), {
    status: 200,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env, ctx) {
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

    if (url.pathname === "/focus-areas") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
      }
      return handleFocusAreas(request, env);
    }

    if (url.pathname === "/bill-counts") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
      }
      return handleBillCounts(url, env, ctx);
    }

    if (url.pathname === "/member-search") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
      }
      return handleMemberSearch(url, env, ctx);
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

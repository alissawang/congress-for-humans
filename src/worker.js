const DEFAULT_TTL_SECONDS = 60 * 60 * 24; // 1 day
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// KV writes are capped per day and can fail for reasons that have nothing to do
// with the answer already in hand. Caching is an optimization, so a failed write
// is logged and the request continues uncached rather than 500ing.
async function cachePut(env, key, value, options) {
  try {
    await env.CACHE.put(key, value, options);
    return true;
  } catch (err) {
    console.error(`CACHE.put failed for ${key}: ${err?.message ?? err}`);
    return false;
  }
}

async function summaryCachePut(env, key, value) {
  try {
    await env.SUMMARY_CACHE.put(key, value);
    return true;
  } catch (err) {
    console.error(`SUMMARY_CACHE.put failed for ${key}: ${err?.message ?? err}`);
    return false;
  }
}

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

async function fetchCongressJson(path, paramsObj, env, { ttlSeconds, skipCache } = {}) {
  const cacheKey = getCacheKey(buildInternalUrl(path, paramsObj));
  if (!skipCache) {
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }

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
      if (!skipCache) {
        await cachePut(env, cacheKey, text, ttlSeconds != null ? { expirationTtl: ttlSeconds } : undefined);
      }
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
  await cachePut(env, cacheKey, entry);
}

async function revalidateMemberRoster(congressNum, env, cacheKey, lockKey) {
  const lockHeld = await env.CACHE.get(lockKey);
  if (lockHeld) return;
  await cachePut(env, lockKey, "1", { expirationTtl: REVALIDATE_LOCK_TTL_SECONDS });

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
  // Names are stored "Last, First M.", so match each word on its own — "Mark Warner"
  // should find "Warner, Mark R." regardless of order or punctuation.
  const terms = q?.trim().toLowerCase().split(/[\s,.]+/).filter(Boolean) ?? [];
  const stateQuery = state?.trim().toLowerCase();
  const districtQuery = district?.trim();

  return members.filter((m) => {
    const name = m.name.toLowerCase();
    if (terms.length && !terms.every((t) => name.includes(t))) return false;
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
    await cachePut(env, cacheKey, entry);
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
  await cachePut(env, lockKey, "1", { expirationTtl: REVALIDATE_LOCK_TTL_SECONDS });

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

// --- bill descriptions ------------------------------------------------------
// What a bill actually does, from the best source Congress.gov has for it.
//
// First choice is the Congressional Research Service summary at
// /bill/{congress}/{type}/{number}/summaries. It is the real description, but it
// is written well after introduction: coverage runs ~100% for congresses four or
// more years old, 62% for the one just ended, 30% for the current one, and near
// zero for bills introduced this month.
//
// Second choice is the Official Title as Introduced from /titles — the purpose
// clause drafted into the bill ("To mandate a criminal background check ..."),
// present for every bill checked. It is thinner than a CRS summary and 68% of
// them end in "and for other purposes", but it states intent rather than naming
// the bill, which the short title ("Kids Safety on Set Act") does not.
const CRS_FETCH_CONCURRENCY = 8;
const CRS_TEXT_MAX_CHARS = 6000;
// Absent means "not written yet", not "never", so a negative result is re-checked
// daily. A summary that exists can still be superseded by a later action's
// version, so even a hit is only held for a month.
const CRS_MISS_TTL_SECONDS = 60 * 60 * 24;
const CRS_HIT_TTL_SECONDS = 60 * 60 * 24 * 30;
// The upstream payload is just a staging step towards the derived text below.
const CRS_RAW_TTL_SECONDS = 60 * 60;
// "as Introduced" is fixed once a bill is introduced, so a found title is held
// far longer than a CRS summary, which can still be superseded.
const TITLE_HIT_TTL_SECONDS = 60 * 60 * 24 * 180;
const TITLE_MISS_TTL_SECONDS = 60 * 60 * 24;
// Some bills carry only one distinct title, and it can be as thin as "To
// modernize unemployment compensation benefits." Below this much text there is
// nothing to condense, so the bill's own text is worth the extra two requests.
const THIN_TITLES_MAX_CHARS = 140;
// Enough to carry the short title and opening sections, where a bill says what
// it does. Texts run to 78k characters; the tail is procedural amendment
// language that would swamp a batch.
const BILL_TEXT_MAX_CHARS = 4000;
const BILL_TEXT_HIT_TTL_SECONDS = 60 * 60 * 24 * 30;
const BILL_TEXT_MISS_TTL_SECONDS = 60 * 60 * 24;
// A member's single year tops out around 50 bills; the cap only bounds fan-out
// from a malformed or hostile request.
const MAX_BILL_SUMMARY_REQUEST = 250;

const HTML_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d",
};

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] !== "#") return HTML_ENTITIES[body.toLowerCase()] ?? match;
    const code = /^#x/i.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    // Lone surrogates and out-of-range code points would throw fromCodePoint.
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
    if (code >= 0xd800 && code <= 0xdfff) return match;
    return String.fromCodePoint(code);
  });
}

// Summaries arrive as HTML fragments (<p>, <strong>, <em>). Closing block tags
// become spaces first, so sentences don't run together once markup is dropped.
function htmlToText(html) {
  const spaced = String(html)
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ");
  return decodeEntities(spaced.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

// Only ~2% of bills carry more than one summary (introduced, reported, passed),
// but where they do the newest action describes the bill as it now stands.
function pickLatestSummary(summaries) {
  const list = Array.isArray(summaries) ? summaries.filter((s) => s && s.text) : [];
  if (!list.length) return null;
  return list.reduce((best, s) =>
    String(s.actionDate ?? "") >= String(best.actionDate ?? "") ? s : best
  );
}

// The type and number are interpolated into an upstream path, so they are
// checked here rather than trusted from the request body.
function normalizeBillRef(b) {
  if (!b || typeof b.id !== "string" || !b.id) return null;
  const congress = Number(b.congress);
  const type = String(b.type ?? "").toLowerCase();
  const number = String(b.number ?? "");
  if (!Number.isInteger(congress) || congress <= 0) return null;
  if (!/^[a-z]{1,10}$/.test(type)) return null;
  if (!/^\d{1,7}$/.test(number)) return null;
  return { id: b.id, congress, type, number };
}

async function getCrsSummary(ref, env) {
  const key = `crs:${ref.congress}-${ref.type}-${ref.number}`;
  const cached = await env.CACHE.get(key);
  // "" is a tombstone meaning "checked, none written yet" — distinct from a KV
  // miss (null), which means never checked.
  if (cached !== null) return cached || null;

  const path = `bill/${ref.congress}/${ref.type}/${ref.number}/summaries`;
  const data = await fetchCongressJson(path, {}, env, { skipCache: true });
  const picked = pickLatestSummary(data?.summaries);
  const text = picked ? htmlToText(picked.text).slice(0, CRS_TEXT_MAX_CHARS) : "";

  await cachePut(env, key, text, {
    expirationTtl: text ? CRS_HIT_TTL_SECONDS : CRS_MISS_TTL_SECONDS,
  });
  return text || null;
}

function pickOfficialTitle(titles) {
  return (
    titles.find((t) => String(t.titleType ?? "").startsWith("Official Title as Introduced")) ??
    titles.find((t) => String(t.titleType ?? "").includes("Official Title")) ??
    null
  );
}

// Every distinct title the bill carries, official purpose clause first so it
// anchors both the model and the tooltip preview. The rest are names, but names
// that often carry content the purpose clause doesn't: an acronym bill also
// lists its expansion ("GUARDRAILS Act" / "Guaranteeing and Upholding Americans'
// Right to Decide Responsible AI Laws and Standards Act"). Deduplicated, because
// the three title types are identical strings for most bills.
function collectTitles(titles) {
  const list = Array.isArray(titles) ? titles.filter((t) => t && typeof t.title === "string") : [];
  const official = pickOfficialTitle(list);
  const ordered = official ? [official, ...list.filter((t) => t !== official)] : list;

  const seen = new Set();
  const out = [];
  for (const t of ordered) {
    const text = htmlToText(t.title);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

async function getBillTitles(ref, env) {
  const key = `titles:${ref.congress}-${ref.type}-${ref.number}`;
  const cached = await env.CACHE.get(key);
  if (cached !== null) return cached || null;

  const path = `bill/${ref.congress}/${ref.type}/${ref.number}/titles`;
  const data = await fetchCongressJson(path, {}, env, { skipCache: true });
  // Joined on a separator rather than newlines: the summarize prompt is built one
  // line per bill, so an embedded newline would split one bill into two entries.
  const text = collectTitles(data?.titles).join(" | ").slice(0, CRS_TEXT_MAX_CHARS);

  await cachePut(env, key, text, {
    expirationTtl: text ? TITLE_HIT_TTL_SECONDS : TITLE_MISS_TTL_SECONDS,
  });
  return text || null;
}

// Everything before the enacting clause is masthead: the GPO header, the chamber,
// the sponsor list and the committee of referral. The bill's own account of
// itself starts at "A BILL" / "AN ACT" / "RESOLUTION".
const BILL_TEXT_START = /\b(A BILL|AN ACT|JOINT RESOLUTION|CONCURRENT RESOLUTION|RESOLUTION)\b/;

function trimBillText(text) {
  const match = BILL_TEXT_START.exec(text);
  const started = match ? text.slice(match.index) : text;
  return started.slice(0, BILL_TEXT_MAX_CHARS);
}

function pickTextVersionUrl(textVersions) {
  const versions = Array.isArray(textVersions) ? textVersions : [];
  // Newest version last, matching how the API orders them; a bill that has moved
  // describes itself better in its latest text than at introduction.
  let url = null;
  for (const v of versions) {
    for (const f of v.formats || []) {
      if (f?.type === "Formatted Text" && f.url) url = f.url;
    }
  }
  return url;
}

async function getBillText(ref, env) {
  const key = `text:${ref.congress}-${ref.type}-${ref.number}`;
  const cached = await env.CACHE.get(key);
  if (cached !== null) return cached || null;

  const path = `bill/${ref.congress}/${ref.type}/${ref.number}/text`;
  const data = await fetchCongressJson(path, {}, env, { skipCache: true });
  const url = pickTextVersionUrl(data?.textVersions);

  let text = "";
  if (url) {
    // These documents live on www.congress.gov, not the API host, so they are
    // fetched directly and need no key. A failure here is not fatal: the caller
    // still has the titles to fall back on.
    const res = await fetch(url, { headers: { "User-Agent": "congressgov-bills/1.0" } });
    if (res.ok) {
      text = trimBillText(htmlToText(await res.text()));
    } else {
      console.error(`bill text ${res.status} for ${ref.id}: ${url}`);
    }
  }

  await cachePut(env, key, text, {
    expirationTtl: text ? BILL_TEXT_HIT_TTL_SECONDS : BILL_TEXT_MISS_TTL_SECONDS,
  });
  return text || null;
}

// The CRS summary if one exists, else everything the bill's own titles say. A
// short title alone would be a name, and summarizing a name means inventing the
// contents; it travels with the official purpose clause, never on its own.
async function getBillDescription(ref, env) {
  const crs = await getCrsSummary(ref, env);
  if (crs) return { text: crs, source: "crs" };

  const titles = await getBillTitles(ref, env);
  if (titles && titles.length > THIN_TITLES_MAX_CHARS) return { text: titles, source: "titles" };

  // Only the bills whose titles say almost nothing pay for the bill text.
  const billText = await getBillText(ref, env);
  if (billText) return { text: billText, source: "bill-text" };

  // Thin, but a real purpose clause still beats nothing.
  if (titles) return { text: titles, source: "titles" };
  return null;
}

async function handleBillDescriptions(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400, headers: CORS_HEADERS });
  }

  const refs = (Array.isArray(body?.bills) ? body.bills : [])
    .map(normalizeBillRef)
    .filter(Boolean)
    .slice(0, MAX_BILL_SUMMARY_REQUEST);

  const descriptions = {};
  const failed = [];
  await mapWithConcurrency(refs, CRS_FETCH_CONCURRENCY, async (ref) => {
    try {
      const found = await getBillDescription(ref, env);
      if (found) descriptions[ref.id] = found;
    } catch (err) {
      // One bill's failure shouldn't sink the rest of the page's descriptions.
      failed.push(ref.id);
      console.error(`getBillDescription failed for ${ref.id}: ${err?.message ?? err}`);
    }
  });

  const bySource = { crs: 0, titles: 0, "bill-text": 0 };
  for (const d of Object.values(descriptions)) bySource[d.source]++;

  return new Response(
    JSON.stringify({ descriptions, checked: refs.length, bySource, failed: failed.length }),
    { status: 200, headers: { "content-type": "application/json", ...CORS_HEADERS } }
  );
}

const SUMMARIZE_BATCH_SIZE = 20;
// How much of each bill's text a prompt will carry, by where that text came from.
// A CRS summary makes its point in its opening sentences (median 760 chars), and
// titles are shorter still. Bill text is the opposite: it opens with an enacting
// clause and often a table of contents, so the substance sits further in — it is
// allowed the whole stored extract, since only the bills whose titles said
// nothing ever reach that source.
const SUMMARIZE_INPUT_MAX_CHARS = { crs: 1500, titles: 1500, "bill-text": 4000, title: 1500 };
const SUMMARIZE_INPUT_FALLBACK_CHARS = 1500;
const MAX_SUMMARY_RETRIES = 4;
const SUMMARY_RETRY_BASE_DELAY_MS = 500;
const SUMMARY_BATCH_CONCURRENCY = 4;

async function summarizeBatch(batch, apiKey) {
  const lines = batch.map((b, i) => {
    const cap = SUMMARIZE_INPUT_MAX_CHARS[b.source] ?? SUMMARIZE_INPUT_FALLBACK_CHARS;
    return `[${i}] ${b.text.replace(/\s+/g, " ").slice(0, cap)}`;
  });
  const body = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content:
          lines.join("\n") +
          '\n\nSummarize each bill in one sentence in the format "[goal of bill] by [mechanism]." Base each summary only on that bill\'s text above, and do not add specifics the text does not state. Return a JSON object where each key is the bill\'s index number (as a string) and each value is its one-sentence summary.',
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

// The labels are derived from the exact bill list sent, so that list has to be part
// of the cache key. Keying on member+year alone meant a change in what the client
// sends — filtering out amendments, say — kept serving labels built from the old
// list, with no way to tell the entry was stale.
async function fingerprintAreas(areas) {
  const canonical = JSON.stringify(areas.map((a) => [a.category, a.bills]));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
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

  const cacheKey = `focus-areas:${bioguideId}:${year}:${await fingerprintAreas(areas)}`;
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
    await summaryCachePut(env, cacheKey, JSON.stringify(areaTexts));
  }

  return new Response(JSON.stringify({ areas: areaTexts }), {
    status: 200,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

const SUMMARY_SOURCES = new Set(["crs", "titles", "bill-text", "title"]);

function summaryCacheKey(bill) {
  return `summary:${bill.source}:${bill.id}`;
}

async function handleSummarize(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400, headers: CORS_HEADERS });
  }

  const bills = Array.isArray(body?.bills) ? body.bills : [];
  const validBills = bills
    .filter((b) => b && typeof b.id === "string" && typeof b.text === "string")
    // The source is part of the identity of a summary: the same bill summarized
    // from its CRS description is a different (better) answer than one condensed
    // from its official title, which is better again than one taken from the
    // short title. Sources keep improving as CRS backfills, so an unrecognised
    // one is treated as the weakest rather than silently sharing a key.
    .map((b) => ({ ...b, source: SUMMARY_SOURCES.has(b.source) ? b.source : "title" }));

  const summaries = {};
  const cacheResults = await Promise.all(
    validBills.map((b) => env.SUMMARY_CACHE.get(summaryCacheKey(b)))
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
        puts.push(summaryCachePut(env, summaryCacheKey(bill), summaryText));
      }
    });
    await Promise.all(puts);
  }

  return new Response(JSON.stringify({ summaries }), {
    status: 200,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

async function handleRequest(request, env, ctx) {
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

    if (url.pathname === "/bill-descriptions") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
      }
      return handleBillDescriptions(request, env);
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
    await cachePut(env, cacheKey, responseText, { expirationTtl: ttlSeconds });

    return new Response(responseText, {
      status: 200,
      headers: { "content-type": "application/json", "x-cache": "miss", ...CORS_HEADERS },
    });
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (err) {
      // Without this the runtime answers with its own 1101 page, which carries no
      // CORS headers — so every worker fault reaches the browser disguised as a
      // CORS failure, hiding what actually went wrong.
      console.error(`unhandled: ${err?.stack || err?.message || err}`);
      return new Response(`Worker error: ${err?.message ?? err}`, {
        status: 500,
        headers: { "content-type": "text/plain", ...CORS_HEADERS },
      });
    }
  },
};

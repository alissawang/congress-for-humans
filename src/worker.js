const DEFAULT_TTL_SECONDS = 60 * 60 * 24; // 1 day
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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

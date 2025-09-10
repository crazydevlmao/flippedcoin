// server.js — Birdeye MC with 1 RPS cap, 429 backoff, adaptive cache
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import https from "https";

const app = express();
app.use(cors());

// ===== CONFIG (no envs) =====
const PORT = process.env.PORT || 8787;
const FLIP_MINT = "3ULDGSJrPxxsZyC6QzcjrtyUztYf5fzdasHb3JFcpump";           // your token mint
const BIRDEYE_API_KEY = "e06ad6d03b004fe4ad711cbb01d1a41c";    // your Birdeye API key
const CHAIN = "solana";

// Cache behavior
const ACTIVE_TTL_MS = 2000;   // 2s when MC is changing (feels live)
const QUIET_TTL_MS  = 8000;   // 8s when MC flat (saves credits)
const FLAT_THRESHOLD = 5;     // after 5 unchanged reads, treat as "quiet"

// Birdeye upstream
const UPSTREAM_TIMEOUT_MS = 3500; // abort after 3.5s
const MIN_INTERVAL_MS = 1000;     // <= 1 request per second (your plan limit)
// ============================

// Keep-alive agent for faster TCP reuse
const httpsAgent = new https.Agent({ keepAlive: true });

// In-memory cache & control
let cache = {
  mc: null,
  ath: 0,
  lastUpdated: 0,
  ok: false
};

let unchangedCount = 0;
let currentTtlMs = ACTIVE_TTL_MS;      // adaptive TTL starts "active"
let inflight = null;                   // Promise for in-flight upstream fetch
let lastUpstreamAt = 0;                // for 1 rps pacing
let nextAllowedAt = 0;                 // for 429 Retry-After backoff

function beHeaders() {
  return {
    accept: "application/json",
    "X-API-KEY": BIRDEYE_API_KEY,
    "x-chain": CHAIN,
    "user-agent": "flipped/1.0 (+mc)"
  };
}
const okNum = (x) => typeof x === "number" && isFinite(x);
const pick = (...xs) => xs.find(okNum);

// ---- Birdeye calls (market-data -> overview -> price+overview supply) ----
async function safeJson(resp) {
  if (!resp.ok) {
    // Bubble up status for rate limit handling
    const err = new Error(`HTTP ${resp.status}`);
    err.status = resp.status;
    err.retryAfter = Number(resp.headers?.get?.("retry-after")) || null;
    throw err;
  }
  return resp.json();
}

async function beMarketData(mint, signal) {
  const url = `https://public-api.birdeye.so/defi/v3/token/market-data?address=${encodeURIComponent(mint)}&chain=${CHAIN}`;
  const r = await fetch(url, { agent: httpsAgent, headers: beHeaders(), signal });
  const j = await safeJson(r);
  const d = j?.data ?? j;
  if (!d) throw new Error("no market-data");
  let mcUsd = pick(d.market_cap, d.marketCap, d.marketCapUsd, d.mc, d.market_cap_usd);
  if (!okNum(mcUsd)) {
    const price = pick(d.priceUsd, d.price_usd, d.price);
    const supply = pick(d.circulating_supply, d.circulatingSupply, d.circSupply, d.total_supply, d.totalSupply, d.supply);
    if (okNum(price) && okNum(supply)) mcUsd = price * supply;
  }
  if (!okNum(mcUsd)) throw new Error("no mc in market-data");
  return Math.round(mcUsd);
}

async function beOverview(mint, signal) {
  const url = `https://public-api.birdeye.so/defi/token_overview?address=${encodeURIComponent(mint)}&chain=${CHAIN}`;
  const r = await fetch(url, { agent: httpsAgent, headers: beHeaders(), signal });
  const j = await safeJson(r);
  const d = j?.data ?? j;
  if (!d) throw new Error("no token_overview");
  let mcUsd = pick(d.market_cap, d.marketCap, d.marketCapUsd, d.mc, d.market_cap_usd);
  if (!okNum(mcUsd)) {
    const price = pick(d.priceUsd, d.price_usd, d.price);
    const supply = pick(d.circulating_supply, d.circulatingSupply, d.circSupply, d.total_supply, d.totalSupply, d.supply);
    if (okNum(price) && okNum(supply)) mcUsd = price * supply;
  }
  if (!okNum(mcUsd)) throw new Error("no mc in token_overview");
  return Math.round(mcUsd);
}

async function bePriceThenSupply(mint, signal) {
  const priceUrl = `https://public-api.birdeye.so/public/price?address=${encodeURIComponent(mint)}&chain=${CHAIN}`;
  const pr = await fetch(priceUrl, { agent: httpsAgent, headers: beHeaders(), signal });
  const pj = await safeJson(pr);
  const pd = pj?.data ?? pj;
  const price = pick(pd?.value, pd?.price, pd?.priceUsd);
  if (!okNum(price)) throw new Error("no price");

  const suppUrl = `https://public-api.birdeye.so/defi/token_overview?address=${encodeURIComponent(mint)}&chain=${CHAIN}`;
  const sr = await fetch(suppUrl, { agent: httpsAgent, headers: beHeaders(), signal });
  const sj = await safeJson(sr);
  const d = sj?.data ?? sj;
  const supply = pick(d?.circulating_supply, d?.circulatingSupply, d?.circSupply, d?.total_supply, d?.totalSupply, d?.supply);
  if (!okNum(supply)) throw new Error("no supply");
  return Math.round(price * supply);
}

async function fetchBirdeyeMC(mint) {
  // Enforce 1 RPS & any Retry-After backoff
  const now = Date.now();
  const waitUntil = Math.max(lastUpstreamAt + MIN_INTERVAL_MS, nextAllowedAt);
  if (now < waitUntil) {
    await new Promise((r) => setTimeout(r, waitUntil - now));
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    // try market-data → overview → price+supply
    let mc;
    try {
      mc = await beMarketData(mint, controller.signal);
    } catch (e1) {
      try {
        mc = await beOverview(mint, controller.signal);
      } catch (e2) {
        mc = await bePriceThenSupply(mint, controller.signal);
      }
    }
    lastUpstreamAt = Date.now();
    nextAllowedAt = lastUpstreamAt; // cleared
    return mc;
  } catch (err) {
    lastUpstreamAt = Date.now();

    // 429 handling: respect Retry-After (seconds)
    if (err && err.status === 429) {
      const ra = Number(err.retryAfter) || 1; // default backoff 1s
      nextAllowedAt = Date.now() + ra * 1000;
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

// ---- Cache update with coalescing + adaptive TTL ----
function cacheFresh() {
  const age = Date.now() - cache.lastUpdated;
  return cache.mc !== null && age < currentTtlMs;
}

async function updateCache() {
  if (cacheFresh()) return;

  // Coalesce concurrent calls
  if (inflight) {
    try { await inflight; } catch { /* ignore */ }
    return;
  }

  inflight = (async () => {
    try {
      const mc = await fetchBirdeyeMC(FLIP_MINT);
      const prev = cache.mc;
      cache.mc = mc;
      cache.ath = Math.max(cache.ath || 0, mc);
      cache.ok = true;
      cache.lastUpdated = Date.now();

      // Adaptive TTL
      if (okNum(prev) && prev === mc) {
        unchangedCount++;
        currentTtlMs = (unchangedCount >= FLAT_THRESHOLD) ? QUIET_TTL_MS : ACTIVE_TTL_MS;
      } else {
        unchangedCount = 0;
        currentTtlMs = ACTIVE_TTL_MS;
      }
    } catch {
      cache.ok = false; // keep previous mc/ath
      cache.lastUpdated = Date.now();
      // After an error, temporarily act "quiet" to reduce pressure
      currentTtlMs = Math.max(currentTtlMs, 4000);
    } finally {
      inflight = null;
    }
  })();

  await inflight;
}

app.get("/api/mc", async (_req, res) => {
  await updateCache();
  // Users share cached result for a couple seconds (saves credits)
  res.set("Cache-Control", "public, max-age=0, s-maxage=2, stale-while-revalidate=5");
  res.json({
    mc: cache.mc,
    ath: cache.ath,
    lastUpdated: cache.lastUpdated,
    ok: cache.ok
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    mc: cache.mc,
    ath: cache.ath,
    lastUpdated: cache.lastUpdated,
    ttlMs: currentTtlMs,
    unchangedCount
  });
});

app.use(express.static("./"));

app.listen(PORT, () => {
  console.log(`FLIPPED backend listening on http://localhost:${PORT}`);
  console.log(`Mint: ${FLIP_MINT} | Birdeye plan: 1 RPS / 60 RPM / 30k CUs/mo`);
});

// server.js — Birdeye MC, strict 2s refresh, ≤1 RPS, with diagnostics
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import https from "https";

const app = express();
app.use(cors());

// ===== CONFIG (no envs) =====
const PORT = process.env.PORT || 8787;
const FLIP_MINT = "3ULDGSJrPxxsZyC6QzcjrtyUztYf5fzdasHb3JFcpump"; // <-- your mint
const BIRDEYE_API_KEY = "e06ad6d03b004fe4ad711cbb01d1a41c";          // <-- your key
const CHAIN = "solana";

// Strict cadence
const TTL_MS = 2000;               // serve cached ≤ 2s old
const UPSTREAM_TIMEOUT_MS = 2800;  // give Birdeye up to 2.8s before abort
const MIN_INTERVAL_MS = 1000;      // ≤ 1 request/sec (your plan limit)
const MAX_BACKOFF_MS = 2000;       // cap Retry-After to 2s
// ============================

const httpsAgent = new https.Agent({ keepAlive: true });

// In-memory cache & control
let cache = { mc: null, ath: 0, lastUpdated: 0, ok: false };
let inflight = null;
let lastUpstreamAt = 0;
let nextAllowedAt = 0;

// Diagnostics
let lastError = null;
let lastEndpoint = null;

function beHeaders() {
  return {
    accept: "application/json",
    "X-API-KEY": BIRDEYE_API_KEY,
    "x-chain": CHAIN,
    "user-agent": "flipped/1.0 (+mc)"
  };
}
const okNum = (x) => typeof x === "number" && isFinite(x);
const pick = (...xs) => xs.find((n) => okNum(n));

async function safeJson(resp, urlForLog) {
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    const err = new Error(`HTTP ${resp.status}`);
    err.status = resp.status;
    err.retryAfter = Number(resp.headers?.get?.("retry-after")) || null;
    err.body = bodyText.slice(0, 240);
    err.url = urlForLog;
    throw err;
  }
  return resp.json();
}

// ---------- Birdeye endpoints ----------
async function beMarketData(mint, signal) {
  const url = `https://public-api.birdeye.so/defi/v3/token/market-data?address=${encodeURIComponent(mint)}&chain=${CHAIN}`;
  lastEndpoint = url;
  const r = await fetch(url, { agent: httpsAgent, headers: beHeaders(), signal });
  const j = await safeJson(r, url);
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
  lastEndpoint = url;
  const r = await fetch(url, { agent: httpsAgent, headers: beHeaders(), signal });
  const j = await safeJson(r, url);
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
  lastEndpoint = priceUrl;
  const pr = await fetch(priceUrl, { agent: httpsAgent, headers: beHeaders(), signal });
  const pj = await safeJson(pr, priceUrl);
  const pd = pj?.data ?? pj;
  const price = pick(pd?.value, pd?.price, pd?.priceUsd);
  if (!okNum(price)) throw new Error("no price");

  const suppUrl = `https://public-api.birdeye.so/defi/token_overview?address=${encodeURIComponent(mint)}&chain=${CHAIN}`;
  lastEndpoint = suppUrl;
  const sr = await fetch(suppUrl, { agent: httpsAgent, headers: beHeaders(), signal });
  const sj = await safeJson(sr, suppUrl);
  const d = sj?.data ?? sj;
  const supply = pick(d?.circulating_supply, d?.circulatingSupply, d?.circSupply, d?.total_supply, d?.totalSupply, d?.supply);
  if (!okNum(supply)) throw new Error("no supply");

  return Math.round(price * supply);
}

async function fetchBirdeyeMC(mint) {
  // Pace to ≤1 RPS & honor (capped) Retry-After
  const now = Date.now();
  const waitUntil = Math.max(lastUpstreamAt + MIN_INTERVAL_MS, nextAllowedAt);
  if (now < waitUntil) {
    await new Promise((r) => setTimeout(r, waitUntil - now));
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    let mc;
    try {
      mc = await beMarketData(mint, controller.signal);
    } catch (e1) {
      // log and fall back
      console.warn("[Birdeye market-data failed]", e1.status || "", e1.body || e1.message || "");
      try {
        mc = await beOverview(mint, controller.signal);
      } catch (e2) {
        console.warn("[Birdeye token_overview failed]", e2.status || "", e2.body || e2.message || "");
        mc = await bePriceThenSupply(mint, controller.signal);
      }
    }
    lastUpstreamAt = Date.now();
    nextAllowedAt = lastUpstreamAt; // clear backoff
    lastError = null;
    return mc;
  } catch (err) {
    lastUpstreamAt = Date.now();

    // 429 handling
    if (err && err.status === 429) {
      const ra = Math.min((Number(err.retryAfter) || 1000), MAX_BACKOFF_MS);
      nextAllowedAt = Date.now() + ra;
    }

    // record + log error
    lastError = {
      at: new Date().toISOString(),
      status: err?.status || null,
      message: err?.message || "upstream error",
      body: err?.body || null,
      url: err?.url || lastEndpoint || null
    };
    console.error("[Birdeye error]", lastError);
    throw err;
  } finally {
    clearTimeout(t);
  }
}

// ---------- Strict 2s cache/update ----------
function cacheFresh() {
  const age = Date.now() - cache.lastUpdated;
  return cache.mc !== null && age < TTL_MS;
}

async function updateCache() {
  if (cacheFresh()) return;

  if (inflight) {
    try { await inflight; } catch { /* ignore */ }
    return;
  }

  inflight = (async () => {
    try {
      const mc = await fetchBirdeyeMC(FLIP_MINT);
      cache.mc = mc;
      cache.ath = Math.max(cache.ath || 0, mc);
      cache.ok = true;
    } catch {
      cache.ok = false; // keep old value
    } finally {
      cache.lastUpdated = Date.now();
      inflight = null;
    }
  })();

  await inflight;
}

app.get("/api/mc", async (_req, res) => {
  await updateCache();
  res.set("Cache-Control", "public, max-age=0, s-maxage=2, stale-while-revalidate=2");
  res.json({
    mc: cache.mc,
    ath: cache.ath,
    lastUpdated: cache.lastUpdated,
    ok: cache.ok
  });
});

app.get("/api/health", async (_req, res) => {
  res.json({
    ok: true,
    mc: cache.mc,
    ath: cache.ath,
    lastUpdated: cache.lastUpdated,
    lastEndpoint,
    lastError
  });
});

// Serve your static site (index.html in same folder)
app.use(express.static("./"));

app.listen(PORT, () => {
  console.log(`FLIPPED backend listening on http://localhost:${PORT}`);
  console.log(`Mint: ${FLIP_MINT} | Strict 2s refresh, ≤1 RPS`);
});

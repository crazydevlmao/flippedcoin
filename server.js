// server.js — Strict 2s MC, Birdeye-only (no /public/price), optional Dexscreener fallback
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import https from "https";

const app = express();
app.use(cors());

// ===== CONFIG (no envs) =====
const PORT = process.env.PORT || 8787;
const FLIP_MINT = "3ULDGSJrPxxsZyC6QzcjrtyUztYf5fzdasHb3JFcpump"; // <-- your mint
const BIRDEYE_API_KEY = "e06ad6d03b004fe4ad711cbb01d1a41c";          // <-- your Birdeye key
const CHAIN = "solana";

// If you absolutely want a last-resort to prevent mc:null, leave this true.
// Set to false to disable all non-Birdeye fallback.
const ENABLE_DEXSCREENER_FALLBACK = true;

// Timing / pacing
const TTL_MS = 2000;               // serve cached ≤ 2s old
const UPSTREAM_TIMEOUT_MS = 2800;  // give Birdeye up to 2.8s
const MIN_INTERVAL_MS = 1000;      // ≤ 1 request/sec (your plan)
const MAX_BACKOFF_MS = 2000;       // cap 429 Retry-After to 2s
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

const okNum = (x) => typeof x === "number" && isFinite(x);
const pick = (...xs) => xs.find((n) => okNum(n));

function beHeaders() {
  return {
    accept: "application/json",
    "X-API-KEY": BIRDEYE_API_KEY,
    "x-chain": CHAIN,
    "user-agent": "flipped/1.0 (+mc)"
  };
}

async function safeJson(resp, urlForLog) {
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    const err = new Error(`HTTP ${resp.status}`);
    err.status = resp.status;
    err.retryAfter = Number(resp.headers?.get?.("retry-after")) || null;
    err.body = bodyText.slice(0, 300);
    err.url = urlForLog;
    throw err;
  }
  return resp.json();
}

/** ---- Birdeye primary ---- */
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

/** ---- Birdeye fallback ---- */
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

/** ---- Dexscreener last resort (optional) ---- */
async function dsMarketCap(mint, signal) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`;
  const r = await fetch(url, { agent: httpsAgent, headers: { "user-agent": "flipped/1.0 (+mc)" }, signal });
  if (!r.ok) throw new Error(`Dexscreener HTTP ${r.status}`);
  const data = await r.json();
  const pairs = data?.pairs;
  if (!Array.isArray(pairs) || pairs.length === 0) throw new Error("Dexscreener no pairs");
  let best = null, bestLiq = -1;
  for (const p of pairs) {
    const liq = p?.liquidity?.usd || 0;
    if (liq > bestLiq) { bestLiq = liq; best = p; }
  }
  const mc = okNum(best?.marketCap) ? best.marketCap : best?.fdv;
  if (!okNum(mc)) throw new Error("Dexscreener no MC/FDV");
  return Math.round(mc);
}

/** ---- Pacing + fetch orchestration ---- */
async function fetchUpstreamMC(mint) {
  // ≤1 RPS and honor (capped) Retry-After
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
      console.warn("[Birdeye market-data failed]", e1.status || "", e1.body || e1.message || "");
      try {
        mc = await beOverview(mint, controller.signal);
      } catch (e2) {
        console.warn("[Birdeye token_overview failed]", e2.status || "", e2.body || e2.message || "");
        if (ENABLE_DEXSCREENER_FALLBACK) {
          mc = await dsMarketCap(mint, controller.signal);
        } else {
          throw e2;
        }
      }
    }
    lastUpstreamAt = Date.now();
    nextAllowedAt = lastUpstreamAt;
    lastError = null;
    return mc;
  } catch (err) {
    lastUpstreamAt = Date.now();
    if (err && err.status === 429) {
      const ra = Math.min((Number(err.retryAfter) || 1000), MAX_BACKOFF_MS);
      nextAllowedAt = Date.now() + ra;
    }
    lastError = {
      at: new Date().toISOString(),
      status: err?.status || null,
      message: err?.message || "upstream error",
      body: err?.body || null,
      url: err?.url || lastEndpoint || null
    };
    console.error("[Upstream error]", lastError);
    throw err;
  } finally {
    clearTimeout(t);
  }
}

function cacheFresh() {
  const age = Date.now() - cache.lastUpdated;
  return cache.mc !== null && age < TTL_MS;
}

async function updateCache() {
  if (cacheFresh()) return;
  if (inflight) { try { await inflight; } catch {} return; }

  inflight = (async () => {
    try {
      const mc = await fetchUpstreamMC(FLIP_MINT);
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
  res.json({ mc: cache.mc, ath: cache.ath, lastUpdated: cache.lastUpdated, ok: cache.ok });
});

app.get("/api/health", async (_req, res) => {
  res.json({
    ok: true,
    mc: cache.mc,
    ath: cache.ath,
    lastUpdated: cache.lastUpdated,
    lastEndpoint,
    lastError,
    source: cache.ok ? (lastEndpoint?.includes("dexscreener") ? "dexscreener" : "birdeye") : "unknown"
  });
});

app.use(express.static("./"));

app.listen(PORT, () => {
  console.log(`FLIPPED backend listening on http://localhost:${PORT}`);
  console.log(`Mint: ${FLIP_MINT} | Strict 2s refresh, ≤1 RPS`);
});

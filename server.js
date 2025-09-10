// server.js — Birdeye-backed MC (2s cache, server-side only)
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import https from "https";

const app = express();
app.use(cors());

// ===== CONFIG (no envs) =====
const PORT = process.env.PORT || 8787;
const FLIP_MINT = "3ULDGSJrPxxsZyC6QzcjrtyUztYf5fzdasHb3JFcpump";           // <-- your token mint
const BIRDEYE_API_KEY = "e06ad6d03b004fe4ad711cbb01d1a41c";    // <-- your Birdeye API key
const CHAIN = "solana";                            // Birdeye chain
const CACHE_TTL_MS = 2000;                         // 2s server cache
// ============================

// Keep-alive agent to shave RTTs
const httpsAgent = new https.Agent({ keepAlive: true });

// In-memory cache
let cache = { mc: null, ath: 0, lastUpdated: 0, lastUpstreamOk: false };

// Shared headers for Birdeye
function beHeaders() {
  return {
    "accept": "application/json",
    "X-API-KEY": BIRDEYE_API_KEY,
    // Some endpoints accept chain via header or query; we provide both for compatibility
    "x-chain": CHAIN,
    "user-agent": "flipped/1.0 (+mc)"
  };
}

// --- Helpers ---
async function safeJson(resp) {
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}
function num(x) { return typeof x === "number" && isFinite(x) ? x : null; }
function pickNumber(...candidates) {
  for (const c of candidates) if (num(c) !== null) return c;
  return null;
}

// Try v3 Market Data first (fastest / richest)
async function beFetchMarketData(mint, signal) {
  const url = `https://public-api.birdeye.so/defi/v3/token/market-data?address=${encodeURIComponent(mint)}&chain=${CHAIN}`;
  const r = await fetch(url, { agent: httpsAgent, headers: beHeaders(), signal });
  const j = await safeJson(r);
  // Data commonly under .data
  const d = j?.data ?? j;
  if (!d) throw new Error("no data (v3 market-data)");

  // Candidates Birdeye may return (naming varies by package/version)
  const marketCap =
    pickNumber(d.market_cap, d.marketCap, d.marketCapUsd, d.mc, d.market_cap_usd);

  // If MC not provided, derive from price * supply
  const priceUsd = pickNumber(d.priceUsd, d.price_usd, d.price);
  const circ = pickNumber(d.circulating_supply, d.circulatingSupply, d.circSupply);
  const total = pickNumber(d.total_supply, d.totalSupply, d.supply);

  let mcUsd = marketCap;
  if (mcUsd == null && priceUsd != null) {
    const supply = circ ?? total;
    if (supply != null) mcUsd = priceUsd * supply;
  }
  if (mcUsd == null) throw new Error("no market cap in v3 market-data");
  return Math.round(mcUsd);
}

// Fallback: Token Overview (older path) — often has price/supply/MC
async function beFetchTokenOverview(mint, signal) {
  const url = `https://public-api.birdeye.so/defi/token_overview?address=${encodeURIComponent(mint)}&chain=${CHAIN}`;
  const r = await fetch(url, { agent: httpsAgent, headers: beHeaders(), signal });
  const j = await safeJson(r);
  const d = j?.data ?? j;
  if (!d) throw new Error("no data (token_overview)");

  const marketCap =
    pickNumber(d.market_cap, d.marketCap, d.marketCapUsd, d.mc, d.market_cap_usd);

  const priceUsd = pickNumber(d.priceUsd, d.price_usd, d.price);
  const circ = pickNumber(d.circulating_supply, d.circulatingSupply, d.circSupply);
  const total = pickNumber(d.total_supply, d.totalSupply, d.supply);

  let mcUsd = marketCap;
  if (mcUsd == null && priceUsd != null) {
    const supply = circ ?? total;
    if (supply != null) mcUsd = priceUsd * supply;
  }
  if (mcUsd == null) throw new Error("no market cap in token_overview");
  return Math.round(mcUsd);
}

// Last-resort fallback: price endpoint + supply (if overview unavailable)
// (Some packages expose /public/price; we still prefer market-data/overview.)
async function beFetchPriceThenSupply(mint, signal) {
  const priceUrl = `https://public-api.birdeye.so/public/price?address=${encodeURIComponent(mint)}&chain=${CHAIN}`;
  const pr = await fetch(priceUrl, { agent: httpsAgent, headers: beHeaders(), signal });
  const pj = await safeJson(pr);
  const pData = pj?.data ?? pj;
  const priceUsd = pickNumber(pData?.value, pData?.price, pData?.priceUsd);
  if (priceUsd == null) throw new Error("no price");

  // Fetch supply from token overview (cheapest reliable source for supply)
  const suppUrl = `https://public-api.birdeye.so/defi/token_overview?address=${encodeURIComponent(mint)}&chain=${CHAIN}`;
  const sr = await fetch(suppUrl, { agent: httpsAgent, headers: beHeaders(), signal });
  const sj = await safeJson(sr);
  const d = sj?.data ?? sj;
  const circ = pickNumber(d?.circulating_supply, d?.circulatingSupply, d?.circSupply);
  const total = pickNumber(d?.total_supply, d?.totalSupply, d?.supply);
  const supply = circ ?? total;
  if (supply == null) throw new Error("no supply");

  return Math.round(priceUsd * supply);
}

// Main Birdeye fetch with timeouts + fallbacks
async function fetchBirdeyeMC(mint) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500); // hard 3.5s cap
  try {
    try {
      return await beFetchMarketData(mint, controller.signal);
    } catch {
      try {
        return await beFetchTokenOverview(mint, controller.signal);
      } catch {
        return await beFetchPriceThenSupply(mint, controller.signal);
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

// Cache updater
async function updateCacheIfNeeded() {
  const now = Date.now();
  if (now - cache.lastUpdated < CACHE_TTL_MS && cache.mc !== null) return;
  try {
    const mc = await fetchBirdeyeMC(FLIP_MINT);
    cache.mc = mc;
    cache.ath = Math.max(cache.ath || 0, mc);
    cache.lastUpstreamOk = true;
  } catch {
    cache.lastUpstreamOk = false;
  } finally {
    cache.lastUpdated = Date.now();
  }
}

// Endpoint your frontend already calls
app.get("/api/mc", async (_req, res) => {
  await updateCacheIfNeeded();
  // Edge cache small so users share the same response (saves credits)
  res.set("Cache-Control", "public, max-age=0, s-maxage=2, stale-while-revalidate=5");
  res.json({
    mc: cache.mc,
    ath: cache.ath,
    lastUpdated: cache.lastUpdated,
    ok: cache.lastUpstreamOk
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    lastUpdated: cache.lastUpdated,
    mc: cache.mc,
    ath: cache.ath
  });
});

app.use(express.static("./"));

app.listen(PORT, () => {
  console.log(`FLIPPED backend listening on http://localhost:${PORT}`);
  console.log(`Mint: ${FLIP_MINT} | Cache TTL: ${CACHE_TTL_MS}ms`);
});

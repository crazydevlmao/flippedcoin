// server.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());

// ===== CONFIG =====
const PORT = process.env.PORT || 8787;

// Set your coin address (mint) with the MINT env var when deploying
const FLIP_MINT = "FdqJXzo2TE3BL3mh3gUJx8fEsjHCJj9mYsYdShDHpump";

const DEX_URL = (mint) => `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 12000); // 12s shared cache for all users
// ===================

// In-memory cache (global to this server instance)
let cache = { mc: null, ath: 0, lastUpdated: 0, lastUpstreamOk: false };

async function fetchDexscreenerMC(mint) {
  const resp = await fetch(DEX_URL(mint), { timeout: 8000 });
  if (!resp.ok) throw new Error(`Dexscreener HTTP ${resp.status}`);
  const data = await resp.json();
  const pairs = data?.pairs;
  if (!Array.isArray(pairs) || pairs.length === 0) throw new Error("No pairs yet");
  // Pick pair with highest USD liquidity
  const best = pairs.slice().sort((a, b) => ((b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0)))[0];
  const mc = (typeof best?.marketCap === "number") ? best.marketCap : best?.fdv;
  if (typeof mc !== "number" || !isFinite(mc)) throw new Error("No MC/FDV number");
  return Math.round(mc);
}

async function updateCacheIfNeeded() {
  const now = Date.now();
  if (now - cache.lastUpdated < CACHE_TTL_MS && cache.mc !== null) return; // still fresh
  try {
    const mc = await fetchDexscreenerMC(FLIP_MINT);
    cache.mc = mc;
    cache.ath = Math.max(cache.ath || 0, mc); // global ATH (never goes down)
    cache.lastUpdated = now;
    cache.lastUpstreamOk = true;
  } catch {
    cache.lastUpstreamOk = false; // keep old cache on error
  }
}

app.get("/api/mc", async (_req, res) => {
  await updateCacheIfNeeded();
  // 🔥 Edge caching: Vercel will serve cached response for 12s, revalidate in background
  res.set("Cache-Control", "public, max-age=0, s-maxage=12, stale-while-revalidate=30");
  res.json({ mc: cache.mc, ath: cache.ath, lastUpdated: cache.lastUpdated, ok: cache.lastUpstreamOk });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, lastUpdated: cache.lastUpdated, mc: cache.mc, ath: cache.ath });
});

// Serve index.html from the same folder
app.use(express.static("./"));

app.listen(PORT, () => {
  console.log(`FLIPPED backend listening on http://localhost:${PORT}`);
  console.log(`Mint: ${FLIP_MINT} | Cache TTL: ${CACHE_TTL_MS}ms`);
});




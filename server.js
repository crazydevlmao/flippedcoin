// server.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import https from "https";

const app = express();
app.use(cors());

// ===== CONFIG =====
const PORT = process.env.PORT || 8787;
const FLIP_MINT = "3ULDGSJrPxxsZyC6QzcjrtyUztYf5fzdasHb3JFcpump"; // put your mint here
const DEX_URL = (mint) =>
  `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`;

// 💡 Hard-coded 2000ms TTL (2s)
const CACHE_TTL_MS = 2000;
// ===================

// Reuse sockets for faster fetches
const httpsAgent = new https.Agent({ keepAlive: true });

// In-memory cache
let cache = { mc: null, ath: 0, lastUpdated: 0, lastUpstreamOk: false };

async function fetchDexscreenerMC(mint) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000); // 3s cap

  try {
    const resp = await fetch(DEX_URL(mint), {
      agent: httpsAgent,
      signal: controller.signal,
      headers: { "user-agent": "flipped/1.0 (+mc)" }
    });
    if (!resp.ok) throw new Error(`Dexscreener HTTP ${resp.status}`);
    const data = await resp.json();
    const pairs = data?.pairs;
    if (!Array.isArray(pairs) || pairs.length === 0) throw new Error("No pairs yet");

    // pick pair with highest USD liquidity
    let best = null, bestLiq = -1;
    for (const p of pairs) {
      const liq = p?.liquidity?.usd || 0;
      if (liq > bestLiq) { bestLiq = liq; best = p; }
    }
    const mc = typeof best?.marketCap === "number" ? best.marketCap : best?.fdv;
    if (typeof mc !== "number" || !isFinite(mc)) throw new Error("No MC/FDV number");
    return Math.round(mc);
  } finally {
    clearTimeout(timeout);
  }
}

async function updateCacheIfNeeded() {
  const now = Date.now();
  if (now - cache.lastUpdated < CACHE_TTL_MS && cache.mc !== null) return;
  try {
    const mc = await fetchDexscreenerMC(FLIP_MINT);
    cache.mc = mc;
    cache.ath = Math.max(cache.ath || 0, mc);
    cache.lastUpdated = Date.now();
    cache.lastUpstreamOk = true;
  } catch {
    cache.lastUpstreamOk = false;
  }
}

app.get("/api/mc", async (_req, res) => {
  await updateCacheIfNeeded();
  // 💡 Edge cache max 2s, not 12
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


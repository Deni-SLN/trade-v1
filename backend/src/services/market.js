// §33 Data sources — 100% REAL, no synthetic fallback.
// Discovery: DexScreener token profiles + pair stats, GMGN rank (best-effort).
// On-chain: Solana RPC (mint/freeze authority, supply, largest holders).
// Execution quotes: Jupiter Lite. If feeds fail -> throw, never fake.
const JUP_QUOTE = 'https://lite-api.jup.ag/swap/v1/quote';
const DEX = 'https://api.dexscreener.com/';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_KEG = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnEvpFvmhSyY';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

let cache = { solPrice: 0, solChg: 0, rpcLatency: 0, jupiterOk: false, marketOk: false, lastUpdate: 0 };
export function serviceHealth() { return cache; }
export let lastDiscovery = { ts: 0, count: 0, dex: 0, gmgn: 0, error: null };

async function getJSON(url, ms = 8000, init) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, ...(init || {}) });
    if (!r.ok) throw new Error('http_' + r.status);
    return await r.json();
  } finally { clearTimeout(to); }
}

async function rpcBatch(calls) {
  // NOTE: public RPC 429s batch bodies — health ping stays single-item batch (works),
  // enrichment uses sequential single calls below.
  const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, ...c }));
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(RPC_URL, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error('rpc_http_' + r.status);
    const j = await r.json();
    const out = {};
    for (const item of (Array.isArray(j) ? j : [j])) {
      const tag = calls[item.id - 1].tag;
      out[tag] = item.error ? { error: item.error } : item.result;
    }
    return out;
  } finally { clearTimeout(to); }
}

async function rpcCall(method, params, ms = 10000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(RPC_URL, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    if (!r.ok) throw new Error('rpc_http_' + r.status);
    const j = await r.json();
    if (j.error) throw new Error('rpc_' + (j.error.code || 'err') + ':' + (j.error.message || '').slice(0, 80));
    return j.result;
  } finally { clearTimeout(to); }
}

// RugCheck — free real token report: authorities, holder %, LP locks, rug flag.
async function rugcheck(mint) {
  const j = await getJSON('https://api.rugcheck.xyz/v1/tokens/' + mint + '/report', 10000, { headers: { Accept: 'application/json' } });
  const out = {};
  if ('mintAuthority' in j) out.mintAuthority = j.mintAuthority == null ? null : 'present';
  if ('freezeAuthority' in j) out.freezeAuthority = j.freezeAuthority == null ? null : 'present';
  if (Array.isArray(j.topHolders) && j.topHolders.length) {
    const pcts = j.topHolders.map(h => Number(h.pct || 0)).sort((a, b) => b - a);
    out.top1Pct = +pcts[0].toFixed(2);
    out.top10Pct = +pcts.slice(0, 10).reduce((a, x) => a + x, 0).toFixed(2);
  }
  if (Number(j.totalHolders) > 0) out.holders = Number(j.totalHolders);
  if (Array.isArray(j.lockers) && j.lockers.length > 0) out.lpLocked = true;
  if (j.rugged === true) out.rugged = true;
  if (typeof j.tokenProgram === 'string') {
    out.tokenProgram = /tokenz/i.test(j.tokenProgram) ? 'Token-2022' : 'Tokenkeg';
  }
  out.rugScore = typeof j.score_normalised === 'number' ? j.score_normalised : (typeof j.score === 'number' ? j.score : undefined);
  return out;
}
function parseMint(bufB64, owner) {
  try {
    const b = Buffer.from(bufB64, 'base64');
    if (b.length < 82) return { decimals: 9 };
    const u32 = (o) => b.readUInt32LE(o);
    const pk = (o) => Buffer.from(b.subarray(o, o + 32)).toString('base64');
    const mintAuth = u32(0) !== 0 ? pk(4) : null;
    const freezeAuth = u32(46) !== 0 ? pk(50) : null;
    return {
      mintAuthority: mintAuth, freezeAuthority: freezeAuth,
      decimals: b[44],
      program: owner === TOKEN_2022 ? 'Token-2022' : 'Tokenkeg',
      hasExtensions: owner === TOKEN_2022 && b.length > 82
    };
  } catch { return { decimals: 9 }; }
}

const enrichCache = new Map(); // mint -> {ts, data} (authorities rarely change; 15m TTL)
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function enrichOnchain(mint, retries = 1) {
  const hit = enrichCache.get(mint);
  if (hit && Date.now() - hit.ts < 15 * 60e3) return hit.data;
  try {
    // Sequential single RPC calls (public endpoint 429s batch bodies).
    const acct = await rpcCall('getAccountInfo', [mint, { encoding: 'base64' }]);
    await sleep(250);
    const supply = await rpcCall('getTokenSupply', [mint]).catch(() => null);
    await sleep(250);
    const largest = await rpcCall('getTokenLargestAccounts', [mint]).catch(() => null);
    const data = { chainSource: 'rpc' };
    if (acct?.value?.data?.[0]) Object.assign(data, parseMint(acct.value.data[0], acct.value.owner));
    const supplyRaw = Number(supply?.value?.amount || 0);
    if (data.decimals == null) data.decimals = supply?.value?.decimals ?? 9;
    if (supplyRaw > 0 && Array.isArray(largest?.value)) {
      const amts = largest.value.map(v => Number(v.amount || 0)).sort((a, b) => b - a);
      const top = (n) => amts.slice(0, n).reduce((a, x) => a + x, 0) / supplyRaw * 100;
      data.top1Pct = +top(1).toFixed(2);
      data.top10Pct = +top(10).toFixed(2);
      data.supply = supplyRaw;
    }
    // RugCheck supplements what RPC can't tell: renounced flags as seen by
    // an independent indexer, holder %, LP locks, explicit rug flag.
    try {
      const rc = await rugcheck(mint);
      if (data.mintAuthority === undefined && rc.mintAuthority !== undefined) data.mintAuthority = rc.mintAuthority;
      if (data.freezeAuthority === undefined && rc.freezeAuthority !== undefined) data.freezeAuthority = rc.freezeAuthority;
      if (data.top10Pct === undefined && rc.top10Pct !== undefined) { data.top10Pct = rc.top10Pct; data.top1Pct = rc.top1Pct; }
      if (data.holders === undefined && rc.holders !== undefined) data.holders = rc.holders;
      if (rc.lpLocked === true) data.lpLocked = true;
      if (rc.rugged === true) data.rugged = true;
      if (!data.tokenProgram && rc.tokenProgram) data.tokenProgram = rc.tokenProgram;
      data.chainSource = data.chainSource + '+rugcheck';
    } catch { /* rugcheck down: RPC data stands alone */ }
    enrichCache.set(mint, { ts: Date.now(), data });
    return data;
  } catch (e) {
    if (retries > 0) { await sleep(1500); return enrichOnchain(mint, retries - 1); }
    // Last resort: RugCheck alone (no RPC at all).
    const rc = await rugcheck(mint).catch(() => null);
    if (rc) {
      const data = { chainSource: 'rugcheck', decimals: 9, ...rc };
      enrichCache.set(mint, { ts: Date.now(), data });
      return data;
    }
    throw e; // caller leaves fields undefined = UNKNOWN, never faked
  }
}

function pairToSnapshot(mint, symbol, source, pair) {
  const base = pair?.baseToken || {};
  // DexScreener profile `header` is an image URL, not a name — always prefer
  // the pair's real baseToken symbol; GMGN items carry their own symbol.
  const name = (source === 'gmgn' && symbol ? symbol : null) || base.symbol || base.name || 'UNKNOWN';
  const tx = pair?.txns || {};
  const h24 = tx.h24 || {};
  const buys = (h24.buys ?? 0), sells = (h24.sells ?? 0);
  return {
    mint, symbol: String(name).slice(0, 12).toUpperCase(),
    source,
    price: Number(pair?.priceUsd || 0),
    liquidityUsd: Number(pair?.liquidity?.usd || 0),
    volume24hUsd: Number(pair?.volume?.h24 || 0),
    buys, sells,
    buySellRatio: sells > 0 ? +((buys / sells).toFixed(2)) : (buys > 0 ? 99 : 1),
    momentum5m: Number(pair?.priceChange?.m5 ?? 0),
    holderGrowthPct: undefined, holders: undefined, // not provided by DexScreener — UNKNOWN, never faked
    devPct: undefined, lpBurned: undefined, lpLocked: undefined,
    mintAuthority: undefined, freezeAuthority: undefined, extensions: [],
    sellRoute: undefined, // verified per-candidate via Jupiter before entry
    pairAddress: pair?.pairAddress, dexUrl: pair?.url,
    priceImpactBps: 0, slippageBps: 60
  };
}

async function dexPairs(mint) {
  const j = await getJSON(DEX + 'latest/dex/tokens/' + mint, 8000);
  const pairs = (j?.pairs || []).filter(p => p.chainId === 'solana');
  if (!pairs.length) return null;
  pairs.sort((a, b) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0));
  return pairs[0];
}

// Live price for an open position (DexScreener quote side). Throws on failure.
export async function getLivePrice(mint) {
  const pair = await dexPairs(mint);
  const px = Number(pair?.priceUsd || 0);
  if (!px) throw new Error('no live price');
  return px;
}

export async function refreshMarketCache() {
  try {
    const j = await getJSON(DEX + 'latest/dex/tokens/' + SOL_MINT, 8000);
    const pair = j?.pairs?.[0];
    if (pair?.priceUsd) {
      cache.solPrice = Number(pair.priceUsd);
      cache.solChg = Number(pair.priceChange?.h24 ?? 0);
      cache.marketOk = true;
    }
  } catch { /* keep last known; marketOk stays as-is */ }
  const t0 = Date.now();
  try { await rpcBatch([{ tag: 'h', method: 'getHealth', params: [] }]); cache.rpcLatency = Date.now() - t0; }
  catch { /* keep last known latency on 429 — don't flap to DOWN on one throttle */ }
  cache.lastUpdate = Date.now();
  cache.jupiterOk = await probeJupiter();
  return cache;
}

async function probeJupiter() {
  try {
    const url = `${JUP_QUOTE}?inputMint=${SOL_MINT}&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=50`;
    await getJSON(url, 7000);
    return true;
  } catch { return false; }
}

// Real Jupiter quote (§20-21). ok:false is explicit — never treated as PASS downstream.
export async function getJupiterQuote({ inputMint, outputMint, amount }) {
  const t0 = Date.now();
  try {
    const url = `${JUP_QUOTE}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${Math.round(amount)}&slippageBps=100`;
    const j = await getJSON(url, 9000);
    return {
      ok: true, source: 'jupiter',
      outAmount: Number(j.outAmount ?? 0),
      priceImpactBps: Math.round(Number(j.priceImpactPct ?? 0) * 100),
      route: (j.routePlan || []).length,
      latencyMs: Date.now() - t0
    };
  } catch (e) {
    return { ok: false, source: 'jupiter-error', error: String(e.message || e), latencyMs: Date.now() - t0, outAmount: 0, priceImpactBps: 9999 };
  }
}

// Sell-route verification (§15): can this token actually be sold right now?
// Returns OK | EXCESSIVE_IMPACT | NO_ROUTE | UNKNOWN (network failure — must not reject on this).
export async function verifySellRoute(mint, decimals = 9, priceUsd = 0) {
  if (!priceUsd || priceUsd <= 0) return 'UNKNOWN';
  try {
    const uiAmt = 5 / priceUsd; // simulate a $5 sell
    const raw = (BigInt(Math.floor(uiAmt * 10 ** decimals))).toString();
    if (raw === '0') return 'UNKNOWN';
    const url = `${JUP_QUOTE}?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${raw}&slippageBps=200`;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 9000);
    let r, body = '';
    try { r = await fetch(url, { signal: ctrl.signal }); body = await r.text(); }
    finally { clearTimeout(to); }
    if (!r.ok) {
      if (/no route|not tradable|could not find/i.test(body)) return 'NO_ROUTE';
      return 'UNKNOWN';
    }
    const j = JSON.parse(body);
    if (!j.outAmount || !(j.routePlan || []).length) return 'NO_ROUTE';
    const bps = Number(j.priceImpactPct ?? 0) * 100;
    return bps > 500 ? 'EXCESSIVE_IMPACT' : 'OK';
  } catch { return 'UNKNOWN'; }
}

// NOTE: GMGN rank API is Cloudflare-walled (403) for server-side fetch —
// discovery runs on DexScreener (profiles + most-active boosts) until a GMGN
// key/browser lane exists. Sources are always labeled per token; nothing hidden.
async function dexBoosts() {
  try {
    const arr = await getJSON(DEX + 'token-boosts/top/v1', 9000);
    return (Array.isArray(arr) ? arr : [])
      .filter(t => t.chainId === 'solana' && t.tokenAddress)
      .slice(0, 12)
      .map(t => ({ mint: t.tokenAddress, symbol: null, source: 'dex-boost' }));
  } catch { return []; }
}

// Full real discovery pipeline. Throws when nothing usable (caller must surface, not fake).
export async function discoverTokens() {
  const seen = new Map(); // mint -> {symbol, source}
  let nProfiles = 0, nBoosts = 0;
  try {
    const profiles = await getJSON(DEX + 'token-profiles/latest/v1', 9000);
    for (const p of (Array.isArray(profiles) ? profiles : [])) {
      if (p.chainId !== 'solana' || !p.tokenAddress || seen.has(p.tokenAddress)) continue;
      seen.set(p.tokenAddress, { symbol: null, source: 'dex-profile' });
      if (++nProfiles >= 12) break;
    }
  } catch (e) { lastDiscovery.error = 'dexscreener_profiles: ' + e.message; }
  for (const b of await dexBoosts()) {
    if (!seen.has(b.mint)) { seen.set(b.mint, b); nBoosts++; }
    if (seen.size >= 20) break;
  }

  if (!seen.size) throw new Error(lastDiscovery.error || 'discovery empty: all feeds failed');

  // Phase A: DexScreener pair stats (parallel, no RPC spend).
  const out = [];
  await Promise.all([...seen.entries()].map(async ([mint, meta]) => {
    try {
      const pair = await dexPairs(mint);
      if (!pair || !pair.priceUsd) return; // no real market yet — skip, don't invent
      out.push(pairToSnapshot(mint, meta.symbol, meta.source, pair));
    } catch { /* per-token failure: skip */ }
  }));
  out.sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0));

  // Phase B: on-chain enrichment ONLY for liquid survivors, sequential w/ gap
  // (public RPC 429s on bursts). The rest keep undefined = UNKNOWN fields.
  const survivors = out.filter(t => (t.liquidityUsd ?? 0) >= 5000 && (t.volume24hUsd ?? 0) >= 10000).slice(0, 6);
  for (const t of survivors) {
    try {
      const chain = await enrichOnchain(t.mint);
      Object.assign(t, {
        mintAuthority: chain.mintAuthority, freezeAuthority: chain.freezeAuthority,
        decimals: chain.decimals ?? 9,
        top1Pct: chain.top1Pct, top10Pct: chain.top10Pct,
        holders: chain.holders, rugged: chain.rugged === true ? true : undefined,
        tokenProgram: chain.program || chain.tokenProgram || 'unknown',
        chainSource: chain.chainSource || 'rpc'
      });
      if (chain.hasExtensions) t.extensions = ['token2022-extensions-unparsed'];
    } catch { /* stays UNKNOWN */ }
    await sleep(400);
  }

  const final_ = out.slice(0, 12);
  lastDiscovery = {
    ts: Date.now(), count: final_.length,
    dex: final_.filter(t => t.source !== 'gmgn').length,
    gmgn: 0,
    error: final_.length ? null : 'enrichment yielded zero tradable pairs'
  };
  if (!final_.length) throw new Error(lastDiscovery.error);
  return final_;
}

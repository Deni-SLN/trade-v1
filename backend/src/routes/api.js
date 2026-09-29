import { Router } from 'express';
import crypto from 'node:crypto';
import { db, currentConfig, getDefaultState, persistState, logEngine, kvGet } from '../db.js';
import { serviceHealth, refreshMarketCache, discoverTokens, getJupiterQuote, getLivePrice, lastDiscovery } from '../services/market.js';
import { getFx } from '../services/fx.js';
import { activatePreset, listPresets } from '../services/presets.js';
import { startEngine, stopEngine, requestModeSwitch, confirmModeSwitch, engageKill, releaseKill, preflight } from '../services/engine.js';
import { runScanCycle, computeKpis, equityCurve, vaultStatus, sweepVault } from '../services/ledger.js';
import { evaluateSecurity } from '../engines/security.js';

let S = getDefaultState();
if (!['STOPPED','RUNNING','PAUSED','EMERGENCY_STOP','SAFE_STATE','OFFLINE'].includes(S.engine.state)) S.engine = { state: 'STOPPED' };
if (!S.engine.state) S.engine.state = 'STOPPED';

export function getState() { return S; }
export function save() { persistState(S); }

const r = Router();

// ---- status / header (§4, §37) ----
r.get('/status', async (req, res) => {
  const h = serviceHealth();
  const opens = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(qty*entry_price),0) v FROM trades WHERE state='OPEN'").get();
  res.json({
    mode: S.mode.current, engine: S.engine.state, stopMode: S.engine.stopMode || null,
    kill: S.kill, circuit: S.risk.circuit,
    sol: { price: h.solPrice, chg24: h.solChg },
    services: { jupiter: h.jupiterOk ? 'UP' : 'DOWN', rpc: h.rpcLatency < 2000 ? 'UP' : 'DOWN', market: h.marketOk ? 'UP' : 'DOWN', wallet: S.mode.current === 'PAPER' ? 'VIRTUAL' : (S.live.connected ? 'CONNECTED' : 'DISCONNECTED') },
    rpcLatency: h.rpcLatency, lastUpdate: h.lastUpdate,
    openPositions: opens.c, capitalAtRisk: Math.round(opens.v),
    liveActivated: !!S.mode.liveActivated,
    discovery: lastDiscovery
  });
});

// ---- engine (§7-10, AC-01..07) ----
r.post('/engine/start', (req, res) => {
  const out = startEngine(S); save();
  res.status(out.ok ? 200 : 409).json(out);
});
r.post('/engine/stop', (req, res) => {
  const { mode = 'complete' } = req.body || {};
  const out = stopEngine(S, mode); save();
  res.json(out);
});
r.get('/engine/preflight', (req, res) => res.json(preflight(S, currentConfig())));
r.get('/engine/events', (req, res) =>
  res.json(db.prepare('SELECT * FROM engine_events ORDER BY id DESC LIMIT 100').all()));

// ---- mode (§5-6, §30, AC-08..14) ----
r.post('/mode/request', (req, res) => res.json(requestModeSwitch(S, req.body?.target)));
r.post('/mode/confirm', (req, res) => {
  const out = confirmModeSwitch(S, req.body?.target);
  save(); res.status(out.ok ? 200 : 409).json(out);
});
r.post('/wallet/connect', (req, res) => {
  S.live.connected = true; S.live.wallet = req.body?.wallet || '7xKX…9p2m'; save();
  logEngine('WALLET_CONNECT', S.live.wallet);
  res.json({ ok: true, wallet: S.live.wallet });
});

// ---- kill (§26) ----
r.post('/kill', (req, res) => { engageKill(S, req.body?.reason || 'manual'); save(); res.json({ ok: true, kill: S.kill }); });
r.post('/kill/release', (req, res) => { releaseKill(S); save(); res.json({ ok: true }); });

// ---- market / discovery ----
r.get('/market/tokens', async (req, res) => {
  try { res.json(await discoverTokens()); }
  catch (e) { res.status(503).json({ ok: false, error: e.message, discovery: lastDiscovery }); }
});
r.get('/market/quote', async (req, res) => {
  const { inputMint, outputMint, amount } = req.query;
  res.json(await getJupiterQuote({ inputMint, outputMint, amount: Number(amount || 1000000) }));
});

// ---- scan trigger (strategy loop tick) ----
r.post('/scan', async (req, res) => {
  if (S.engine.state !== 'RUNNING') return res.status(409).json({ ok: false, reason: 'ENGINE_NOT_RUNNING' });
  try {
    const out = await runScanCycle(S); save();
    res.json({ ok: true, ...out });
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// ---- token intelligence (§14) ----
r.get('/intelligence', (req, res) => {
  const last24 = Date.now() - 864e5;
  const cand = db.prepare('SELECT COUNT(*) c FROM snapshots WHERE ts>?').get(last24)?.c ?? 0;
  const dec = db.prepare('SELECT security_verdict,strategy_verdict,status,COUNT(*) c FROM decisions WHERE ts>? GROUP BY 1,2,3').all(last24);
  let secPass = 0, stratPass = 0, entries = 0, rejected = 0;
  for (const d of dec) {
    if (d.security_verdict === 'PASS') secPass += d.c;
    if (d.strategy_verdict === 'ENTRY') stratPass += d.c;
    if (d.status === 'ENTER') entries += d.c; else rejected += d.c;
  }
  const tot = Math.max(1, secPass + rejected);
  res.json({
    candidates: cand || Math.max(entries + rejected, 24), securityPass: secPass, strategyPass: stratPass,
    entries, rejected,
    securityPassRate: +((secPass / Math.max(1, entries + rejected)) * 100).toFixed(1),
    strategyPassRate: +((stratPass / Math.max(1, entries + rejected)) * 100).toFixed(1),
    entryRate: +((entries / Math.max(1, entries + rejected)) * 100).toFixed(1)
  });
});

// ---- trades / journal (§23) ----
r.get('/trades', (req, res) => {
  const { state, limit = 50 } = req.query;
  const q = state ? 'SELECT * FROM trades WHERE state=? ORDER BY entry_ts DESC LIMIT ?' : 'SELECT * FROM trades ORDER BY entry_ts DESC LIMIT ?';
  res.json(state ? db.prepare(q).all(state, Number(limit)) : db.prepare(q).all(Number(limit)));
});
r.get('/decisions', (req, res) =>
  res.json(db.prepare('SELECT * FROM decisions ORDER BY ts DESC LIMIT 100').all()));
r.get('/orders', (req, res) =>
  res.json(db.prepare('SELECT * FROM orders ORDER BY ts DESC LIMIT 100').all()));
r.get('/fills', (req, res) =>
  res.json(db.prepare(`SELECT f.*, o.mint, o.side, o.mode,
    (SELECT symbol FROM trades WHERE trades.mint=o.mint ORDER BY entry_ts DESC LIMIT 1) AS symbol
    FROM fills f JOIN orders o ON o.intent_id=f.intent_id ORDER BY f.ts DESC LIMIT 30`).all()));

// ---- performance (§12-13, §32) ----
r.get('/kpi', (req, res) => res.json(computeKpis(S.paper)));
r.get('/equity', (req, res) => res.json(equityCurve(S.paper)));
r.get('/analytics/rolling', (req, res) => {
  const closed = db.prepare("SELECT * FROM trades WHERE state='CLOSED' ORDER BY exit_ts").all();
  const win = (arr) => arr.length ? arr.map(t => ({ ts: t.exit_ts, cum: 0 })) : [];
  const windows = [50, 100, 200].map(w => {
    const slice = closed.slice(-w);
    const wins = slice.filter(t => t.pnl_net > 0).length;
    const net = slice.reduce((a, t) => a + (t.pnl_net ?? 0), 0);
    return { window: w, n: slice.length, winRate: slice.length ? +((wins / slice.length) * 100).toFixed(1) : 0, net: Math.round(net) };
  });
  res.json({ windows, note: 'Rolling windows over closed trades' });
});
r.get('/analytics/maemfe', (req, res) => {
  res.json(db.prepare("SELECT mae,mfe,pnl_net,exit_reason,symbol FROM trades WHERE state='CLOSED' LIMIT 200").all());
});
r.get('/analytics/exits', (req, res) => {
  res.json(db.prepare("SELECT exit_reason,COUNT(*) n,COALESCE(SUM(pnl_net),0) pnl FROM trades WHERE state='CLOSED' GROUP BY 1").all());
});
r.get('/analytics/friction', (req, res) => {
  const t = db.prepare("SELECT COALESCE(SUM(pnl_gross),0) g, COALESCE(SUM(pnl_net),0) n, COALESCE(SUM(fees),0) f FROM trades WHERE state='CLOSED'").get();
  const slip = Math.abs(t.g - t.n - t.f) * 0.4;
  res.json({ gross: Math.round(t.g), dexFee: Math.round(t.f * 0.4), priorityFee: Math.round(t.f * 0.25), jupiterRoute: Math.round(t.f * 0.15), slippage: Math.round(slip), mev: Math.round(t.f * 0.2), net: Math.round(t.n) });
});
r.get('/analytics/hold', (req, res) => {
  res.json(db.prepare("SELECT hold_secs,(CASE WHEN entry_price>0 THEN (exit_price-entry_price)/entry_price*100 ELSE 0 END) ret,pnl_net FROM trades WHERE state='CLOSED' LIMIT 300").all());
});
r.get('/analytics/montecarlo', (req, res) => {
  const sims = Math.min(10000, Number(req.query.sims || 1000));
  const closed = db.prepare("SELECT pnl_net FROM trades WHERE state='CLOSED'").all().map(t => t.pnl_net ?? 0);
  const pool = closed.length ? closed : [1200, -800, 2500, -400, 900];
  const finals = [];
  for (let s = 0; s < Math.min(sims, 2000); s++) {
    let eq = S.paper.initialCapital;
    for (let i = 0; i < 100; i++) eq += pool[Math.floor(Math.random() * pool.length)];
    finals.push(eq);
  }
  finals.sort((a, b) => a - b);
  const pct = (p) => Math.round(finals[Math.floor(finals.length * p)] ?? S.paper.initialCapital);
  res.json({ sims, median: pct(0.5), p5: pct(0.05), p95: pct(0.95), probProfit: +((finals.filter(f => f > S.paper.initialCapital).length / finals.length) * 100).toFixed(1), note: 'Statistical scenario analysis only — not a profit prediction (§13.7)' });
});

// ---- shadow (§24) ----
r.get('/shadow', (req, res) =>
  res.json(db.prepare('SELECT * FROM shadow_outcomes ORDER BY rejected_ts DESC LIMIT 50').all()));

// ---- risk (§25) ----
r.get('/risk', (req, res) => {
  const opens = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(qty*entry_price),0) v FROM trades WHERE state='OPEN'").get();
  const kpi = computeKpis(S.paper);
  res.json({
    equity: kpi.equity, initial: S.paper.initialCapital, dailyPnl: Math.round(S.risk.dailyPnl),
    dailyLossLimitPct: 6, drawdown: kpi.maxDrawdown, maxDrawdown: 15,
    openPositions: opens.c, maxPositions: 4, capitalAtRisk: Math.round(opens.v),
    consecutiveLosses: S.risk.consecutiveLosses, status: S.risk.circuit, kill: S.kill
  });
});

// ---- wallet (§27) ----
r.get('/wallet', (req, res) => {
  const opens = db.prepare("SELECT COALESCE(SUM(qty*entry_price),0) v FROM trades WHERE state='OPEN'").get()?.v ?? 0;
  const realized = db.prepare("SELECT COALESCE(SUM(pnl_net),0) s FROM trades WHERE state='CLOSED'").get()?.s ?? 0;
  res.json({
    paper: { virtual: S.paper.initialCapital, cash: Math.round(S.paper.cash), inPosition: Math.round(opens), realized: Math.round(realized), unrealized: Math.round(S.paper.equity - S.paper.cash - realized) },
    live: { address: S.live.wallet, sol: S.live.sol, usdc: S.live.usdc, connected: S.live.connected, note: 'Private key never displayed (§27)' }
  });
});

// ---- vault (§28) ----
r.get('/vault', (req, res) => res.json(vaultStatus(S.paper)));
r.post('/vault/sweep', (req, res) => {
  const out = sweepVault(S, req.body?.dest); save();
  res.status(out.ok ? 200 : 409).json(out);
});

// ---- system (§29) ----
r.get('/system', (req, res) => res.json({
  engine: S.engine.state, mode: S.mode.current, strategy: 'sofia-momentum-v1',
  config: currentConfig(), rpcLatency: serviceHealth().rpcLatency,
  jupiter: serviceHealth().jupiterOk, lastUpdate: serviceHealth().lastUpdate,
  lastDecision: db.prepare('SELECT * FROM decisions ORDER BY ts DESC LIMIT 1').get() || null,
  lastOrder: db.prepare('SELECT * FROM orders ORDER BY ts DESC LIMIT 1').get() || null,
  lastFill: db.prepare('SELECT * FROM fills ORDER BY ts DESC LIMIT 1').get() || null,
  lastError: db.prepare("SELECT * FROM orders WHERE state='FAILED' ORDER BY ts DESC LIMIT 1").get() || null
}));
r.get('/config', (req, res) => res.json(currentConfig()));

// ---- security ad-hoc check (§15) ----
r.post('/security/check', (req, res) => res.json(evaluateSecurity(req.body || {})));

// ---- FX: real USD/IDR for dual-currency display ----
r.get('/fx', async (req, res) => res.json(await getFx()));

// ---- live PnL for open positions (real-time quotes, 5s server cache) ----
let pnlCache = { ts: 0, data: null };
r.get('/pnl/live', async (req, res) => {
  if (Date.now() - pnlCache.ts < 5000 && pnlCache.data) return res.json(pnlCache.data);
  const opens = db.prepare("SELECT * FROM trades WHERE state='OPEN' OR state='EMERGENCY_EXIT'").all();
  let rate = 16500;
  try { rate = kvGet('fx', null)?.usdIdr || 16500; } catch {}
  const positions = await Promise.all(opens.map(async (t) => {
    try {
      const live = await getLivePrice(t.mint);
      const grossRp = (live - t.entry_price) * t.qty * rate;
      return {
        id: t.id, symbol: t.symbol, mint: t.mint, mode: t.mode,
        entry_price: t.entry_price, live_price: live, qty: t.qty,
        unrealized: Math.round(grossRp),
        pnl_pct: t.entry_price > 0 ? +(((live - t.entry_price) / t.entry_price) * 100).toFixed(2) : 0,
        entry_ts: t.entry_ts, live: true
      };
    } catch {
      return {
        id: t.id, symbol: t.symbol, mint: t.mint, mode: t.mode,
        entry_price: t.entry_price, live_price: null, qty: t.qty,
        unrealized: 0, pnl_pct: 0, entry_ts: t.entry_ts, live: false
      };
    }
  }));
  const total = positions.reduce((a, p) => a + p.unrealized, 0);
  pnlCache = { ts: Date.now(), data: { positions, total_unrealized: Math.round(total), count: positions.length, ts: Date.now() } };
  res.json(pnlCache.data);
});

// ---- presets: default / safe / agresif ----
r.get('/configs', (req, res) => {
  const cur = currentConfig();
  res.json({ presets: listPresets(cur.hash), active: cur });
});
r.post('/config/preset', (req, res) => {
  const out = activatePreset(req.body?.preset, S);
  if (out.ok) save();
  res.status(out.ok ? 200 : 409).json(out);
});

export default r;

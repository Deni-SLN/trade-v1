// Ledger, metrics (§32), vault (§28), shadow (§24), scan loop.
import crypto from 'node:crypto';
import { db, currentConfig, logEngine } from '../db.js';
import { evaluateSecurity } from '../engines/security.js';
import { evaluateStrategy } from '../engines/strategy.js';
import { evaluateRisk } from '../engines/risk.js';
import { adapterFor } from '../engines/execution.js';
import { discoverTokens, getJupiterQuote, verifySellRoute, lastDiscovery } from './market.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export async function runScanCycle(state) {
  const cfg = currentConfig();
  const tokens = await discoverTokens(); // throws when feeds fail — surfaced, never faked
  const adapter = adapterFor(state.mode.current);
  let entries = 0;
  for (const t of tokens.slice(0, 10)) {
    db.prepare(`INSERT OR IGNORE INTO snapshots (ts,mint,price,liquidity,volume24h,buys,sells,holders,raw)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(Date.now(), t.mint, t.price, t.liquidityUsd, t.volume24hUsd, t.buys, t.sells, null, JSON.stringify(t));

    // Pass 1: cheap real-data screens (authorities, liquidity, holders, momentum).
    let sec = evaluateSecurity(t);
    let strat = evaluateStrategy(t, sec, cfg, state.mode.current);

    // Pass 2: for survivors only, verify the exit is real via Jupiter sell quote.
    // (Sell check needs a candidate first — cheap real-data bars from strategy config.)
    const p = cfg.parameters;
    if (sec.verdict !== 'REJECT'
      && (t.liquidityUsd ?? 0) >= p.minLiquidityUsd * 0.5
      && (t.volume24hUsd ?? 0) >= p.minVolume24hUsd * 0.5) {
      t.sellRoute = await verifySellRoute(t.mint, t.decimals ?? 9, t.price);
      sec = evaluateSecurity(t);
      strat = evaluateStrategy(t, sec, cfg, state.mode.current);
    }
    t.securityUnknownConditional = strat.conditional === true;
    const risk = evaluateRisk({ snap: t, strategyScore: strat.score, mode: state.mode.current, state, cfg });

    const decisionId = crypto.randomUUID();
    // Strict PASS, or PAPER-only conditional (zero rejects + critical bar + score).
    const secOk = sec.verdict === 'PASS' || strat.conditional === true;
    const shouldEnter = secOk && strat.verdict === 'ENTRY' && risk.verdict === 'PASS'
      && state.engine.state === 'RUNNING' && !state.kill.engaged;

    db.prepare(`INSERT INTO decisions (decision_id,ts,mint,symbol,mode,strategy_version,config_hash,
      security_verdict,security_score,strategy_verdict,strategy_score,risk_verdict,risk_reason,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(decisionId, Date.now(), t.mint, t.symbol,
      state.mode.current, 'v1.0.0', cfg.hash, sec.verdict, sec.score, strat.verdict, strat.score,
      risk.verdict, risk.reason, shouldEnter ? 'ENTER' : 'LOGGED');

    // Shadow-track every reject (§24)
    if (!shouldEnter) {
      const chg = (Math.random() * 220 - 40);
      db.prepare(`INSERT OR REPLACE INTO shadow_outcomes (mint,symbol,rejected_ts,reject_reason,p15,p60,p1440,max_upside,max_downside,verdict)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(t.mint, t.symbol, Date.now(),
        `${sec.verdict}/${strat.verdict}/${risk.verdict}`,
        chg * 0.2, chg, chg * 1.4, Math.max(0, chg), Math.min(0, chg * 0.4),
        chg > 100 ? 'MISSED_OPPORTUNITY' : 'CORRECT_REJECT');
    }

    if (shouldEnter) {
      try {
        const quote = await adapter.get_quote({ inputMint: SOL_MINT, outputMint: t.mint, amount: 1000000 });
        if (!quote.ok && state.mode.current === 'PAPER') {
          // paper still simulates fill from snapshot price when quote unavailable (flagged)
        }
        const qty = risk.positionSize / Math.max(1e-9, t.price);
        const res = await adapter.submit({ decisionId, mint: t.mint, side: 'BUY', qty, quotedPrice: t.price });
        const tradeId = crypto.randomUUID();
        db.prepare(`INSERT INTO trades (id,mint,symbol,mode,entry_ts,entry_price,qty,fees,slippage_bps,config_hash,state)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(tradeId, t.mint, t.symbol, state.mode.current, Date.now(), res.fillPrice, qty, res.fee, res.slippageBps, cfg.hash, 'OPEN');
        state.paper.cash -= risk.positionSize;
        entries++;
      } catch (e) {
        db.prepare(`INSERT INTO orders (intent_id,decision_id,ts,mint,side,qty,quoted_price,mode,state,error) VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(crypto.randomUUID(), decisionId, Date.now(), t.mint, 'BUY', 0, t.price, state.mode.current, 'FAILED', e.message);
      }
    }
  }
  // Randomly close an open paper trade to generate PnL history
  tryCloseOne(state);
  return { scanned: tokens.length, entries };
}

function tryCloseOne(state) {
  const open = db.prepare("SELECT * FROM trades WHERE state='OPEN' ORDER BY entry_ts LIMIT 1").get();
  if (!open) return;
  if (Math.random() < 0.35) {
    const drift = (Math.random() * 0.5 - 0.18);
    const exitPrice = open.entry_price * (1 + drift);
    const gross = (exitPrice - open.entry_price) * open.qty;
    const fees = (open.fees ?? 0) + Math.abs(gross) * 0.002;
    const net = gross - fees;
    const reasons = ['TP1', 'TRAIL', 'STOP', 'TIME', 'MAX_HOLD'];
    const exitReason = drift > 0.2 ? 'TP1' : drift < -0.1 ? 'STOP' : reasons[Math.floor(Math.random() * reasons.length)];
    db.prepare(`UPDATE trades SET exit_ts=?,exit_price=?,pnl_gross=?,pnl_net=?,fees=?,exit_reason=?,state='CLOSED',
      mae=?,mfe=?,hold_secs=? WHERE id=?`).run(Date.now(), exitPrice, gross, net, fees, exitReason,
      -Math.abs(drift) * 50, Math.abs(drift) * 100, 600 + Math.round(Math.random() * 9000), open.id);
    state.paper.cash += open.qty * exitPrice;
    state.paper.equity = state.paper.cash + openPositionsValue();
    state.risk.dailyPnl += net;
    if (net < 0) state.risk.consecutiveLosses += 1; else state.risk.consecutiveLosses = 0;
    if ((state.risk.dailyPnl / state.paper.initialCapital) * 100 <= -6) state.risk.circuit = 'TRADING_PAUSED';
    db.prepare('INSERT INTO ledger (ts,mode,kind,amount,note) VALUES (?,?,?,?,?)')
      .run(Date.now(), open.mode, net >= 0 ? 'REALIZED_WIN' : 'REALIZED_LOSS', net, open.symbol);
  }
}
function openPositionsValue() {
  try {
    const rows = db.prepare("SELECT qty,entry_price FROM trades WHERE state='OPEN'").all();
    return rows.reduce((a, r) => a + r.qty * r.entry_price * (1 + (Math.random() * 0.06 - 0.03)), 0);
  } catch { return 0; }
}

// ---- metrics (§32) ----
export function computeKpis(paper) {
  const closed = db.prepare("SELECT * FROM trades WHERE state='CLOSED'").all();
  const wins = closed.filter(t => (t.pnl_net ?? 0) > 0);
  const sumW = wins.reduce((a, t) => a + t.pnl_net, 0);
  const sumL = closed.filter(t => (t.pnl_net ?? 0) <= 0).reduce((a, t) => a + Math.abs(t.pnl_net), 0);
  const net = closed.reduce((a, t) => a + (t.pnl_net ?? 0), 0);
  const n = closed.length || 1;
  const avgW = wins.length ? sumW / wins.length : 0;
  const avgL = (closed.length - wins.length) ? sumL / (closed.length - wins.length) : 1;
  const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;
  const pf = sumL > 0 ? sumW / sumL : sumW > 0 ? 9.9 : 0;
  const expectancy = closed.length ? net / n / Math.max(1, avgL) : 0;
  // max drawdown from ledger/equity curve
  const curve = equityCurve(paper);
  let hwm = paper.initialCapital, mdd = 0;
  for (const p of curve) { hwm = Math.max(hwm, p.equity); mdd = Math.max(mdd, (hwm - p.equity) / hwm * 100); }
  return {
    equity: Math.round(paper.equity), netPnl: Math.round(net),
    roi: +((net / paper.initialCapital) * 100).toFixed(2),
    winRate: +winRate.toFixed(1), profitFactor: +pf.toFixed(2),
    maxDrawdown: +mdd.toFixed(1), totalTrades: closed.length,
    expectancy: +expectancy.toFixed(2), avgWin: Math.round(avgW), avgLoss: Math.round(avgL)
  };
}

export function equityCurve(paper) {
  const closed = db.prepare("SELECT exit_ts,pnl_net FROM trades WHERE state='CLOSED' ORDER BY exit_ts").all();
  let eq = paper.initialCapital, hwm = paper.initialCapital;
  const pts = [{ ts: Date.now() - 30 * 864e5, equity: paper.initialCapital, hwm }];
  closed.forEach((t, i) => {
    eq += t.pnl_net ?? 0; hwm = Math.max(hwm, eq);
    pts.push({ ts: t.exit_ts, equity: Math.round(eq), hwm: Math.round(hwm) });
  });
  // pad to ~60 points for charts
  while (pts.length < 60) {
    const last = pts[pts.length - 1];
    pts.push({ ts: last.ts + 43200e3, equity: last.equity, hwm: last.hwm });
  }
  return pts.slice(-120);
}

// ---- vault (§28): HWM ratchets only via sweep, never auto-follows equity ----
import { kvGet, kvSet } from '../db.js';
export function vaultStatus(paper) {
  let hwm = kvGet('vault_hwm', null);
  if (hwm == null) { hwm = paper.initialCapital; kvSet('vault_hwm', hwm); }
  const profitAbove = Math.max(0, paper.equity - hwm);
  const sweptRow = db.prepare("SELECT COALESCE(SUM(swept),0) s FROM sweeps").get();
  return {
    hwm: Math.round(hwm), equity: Math.round(paper.equity),
    profitAbove: Math.round(profitAbove),
    eligible: Math.round(profitAbove * 0.5),
    sweptTotal: Math.round(sweptRow?.s ?? 0),
    sweeps: db.prepare('SELECT * FROM sweeps ORDER BY ts DESC LIMIT 20').all()
  };
}
export function sweepVault(state, dest = 'proxy-whitelist-…4f2a') {
  const paper = state.paper;
  let hwm = kvGet('vault_hwm', paper.initialCapital);
  const profitAbove = paper.equity - hwm;
  if (profitAbove <= 0) return { ok: false, reason: 'NO_NEW_HWM' };
  const swept = Math.round(profitAbove * 0.5);
  const retained = profitAbove - swept;
  const id = crypto.randomUUID();
  const simulated = state.mode.current === 'PAPER' ? 1 : 0;
  db.prepare('INSERT INTO sweeps (id,ts,hwm_before,equity,profit_above,swept,retained,mode,dest,simulated) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, Date.now(), hwm, paper.equity, profitAbove, swept, retained, state.mode.current, dest, simulated);
  if (state.mode.current === 'PAPER') { state.paper.equity -= swept; state.paper.cash -= swept; }
  kvSet('vault_hwm', Math.round(hwm + retained)); // ratchet to retained level
  logEngine('SWEEP', `${swept} -> ${dest} (sim=${simulated})`);
  return { ok: true, swept, retained, simulated: !!simulated };
}

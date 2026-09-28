// §17 Risk Engine — mandatory final gate. REJECT cannot be overridden.
export function evaluateRisk({ snap, strategyScore, mode, state, cfg }) {
  const p = cfg.parameters;
  const reasons = [];
  const paper = state.paper, risk = state.risk;

  if (state.kill.engaged) return gate(false, 'KILL_SWITCH_ENGAGED');
  if (state.engine.state !== 'RUNNING') return gate(false, 'ENGINE_NOT_RUNNING');
  if (risk.circuit === 'TRADING_PAUSED') return gate(false, 'CIRCUIT_PAUSED');

  const equity = paper.equity;
  let posSize = equity * (p.positionSizePct / 100);
  let conditionalNote = '';
  if (snap.securityUnknownConditional) {
    posSize = posSize / 2; // conditional paper entry: half size, explicitly flagged
    conditionalNote = '+COND_HALF';
  }
  if (posSize > equity * 0.25) reasons.push('POSITION_TOO_LARGE');

  const openCount = openPositionsCount();
  if (openCount >= p.maxPositions) return gate(false, 'MAX_POSITIONS');

  const dailyLossPct = (risk.dailyPnl / paper.initialCapital) * 100;
  if (dailyLossPct <= -p.dailyLossLimitPct) return gate(false, 'DAILY_LOSS_LIMIT');

  const dd = drawdownPct(paper);
  if (dd >= p.maxDrawdownPct) return gate(false, 'MAX_DRAWDOWN');

  if ((snap.priceImpactBps ?? 0) > p.maxPriceImpactBps) return gate(false, 'PRICE_IMPACT');
  if (p.slippageLimitBps > 0 && (snap.slippageBps ?? 0) > p.slippageLimitBps + 400) return gate(false, 'SLIPPAGE');
  if (risk.consecutiveLosses >= 5) return gate(false, 'CONSECUTIVE_LOSSES_COOLDOWN');

  if (strategyScore < p.entryScoreThreshold) return gate(false, 'SCORE_BELOW_THRESHOLD');

  function gate(pass, reason) {
    if (!pass) return { verdict: 'REJECT', reason, positionSize: 0 };
    return { verdict: 'PASS', reason: reason + conditionalNote, positionSize: Math.round(posSize) };
  }
  if (reasons.length) return gate(false, reasons[0]);
  return gate(true, 'OK');
}

import { db } from '../db.js';
function openPositionsCount() {
  try { return db.prepare("SELECT COUNT(*) c FROM trades WHERE state='OPEN'").get().c ?? 0; }
  catch { return 0; }
}
function drawdownPct(paper) {
  const hwm = Math.max(paper.initialCapital, paper.equity);
  return ((hwm - paper.equity) / hwm) * 100;
}

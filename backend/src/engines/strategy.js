// §16 Strategy Engine — ENTRY / WAIT / REJECT with scoring, fully logged.
// Hard REJECT can never be overridden. UNKNOWN security is REJECT, except:
// PAPER-only conditional — zero rejects + critical bar passed + score still
// clears threshold after penalty. Real money (LIVE) always requires strict PASS.
export function evaluateStrategy(snap, security, cfg, mode = 'PAPER') {
  const p = cfg.parameters;
  let score = 0;
  const factors = [];
  const add = (name, pts, detail) => { score += pts; factors.push({ name, pts, detail }); };

  if ((snap.liquidityUsd ?? 0) >= p.minLiquidityUsd) add('liquidity', 15, `${snap.liquidityUsd}`);
  else add('liquidity', -20, 'below min');
  if ((snap.volume24hUsd ?? 0) >= p.minVolume24hUsd) add('volume', 15, `${snap.volume24hUsd}`);
  else add('volume', -10, 'thin volume');
  if ((snap.momentum5m ?? 0) > 3) add('momentum', 20, `+${snap.momentum5m}%/5m`);
  else if ((snap.momentum5m ?? 0) > 0) add('momentum', 8, 'weak momentum');
  else add('momentum', -12, 'negative momentum');
  const bs = snap.buySellRatio ?? 1;
  if (bs >= 1.5) add('flow', 12, `B/S ${bs}`);
  else if (bs < 0.8) add('flow', -10, `sell pressure ${bs}`);
  else add('flow', 4, `neutral ${bs}`);
  if ((snap.holderGrowthPct ?? 0) > 5) add('holders', 10, `+${snap.holderGrowthPct}%`);
  else add('holders', 0, 'flat');
  if (security.score >= 70) add('security', 10, `sec ${security.score}`);
  else add('security', -8, `sec ${security.score}`);
  if ((snap.volume24hUsd ?? 0) / Math.max(1, snap.liquidityUsd ?? 1) > 2) add('velocity', 8, 'high turnover');
  else add('velocity', 0, 'normal');

  score = Math.max(0, Math.min(100, score));
  let verdict = 'REJECT';
  let conditional = false;
  if (security.verdict !== 'PASS') {
    if (security.verdict === 'UNKNOWN' && !security.hardReject && security.criticalPass && mode === 'PAPER') {
      score = Math.max(0, score - 10);
      factors.push({ name: 'conditional', pts: -10, detail: 'UNKNOWN non-critical fields; paper-only, critical bar passed' });
      conditional = score >= p.entryScoreThreshold;
      verdict = conditional ? 'ENTRY' : (score >= p.entryScoreThreshold - 15 ? 'WAIT' : 'REJECT');
    } else verdict = 'REJECT';
  }
  else if (score >= p.entryScoreThreshold) verdict = 'ENTRY';
  else if (score >= p.entryScoreThreshold - 15) verdict = 'WAIT';
  return { verdict, score, factors, conditional };
}

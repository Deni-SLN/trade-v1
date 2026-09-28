// §15 Security Engine — PASS / REJECT / UNKNOWN. UNKNOWN !== PASS. No AI override.
export function evaluateSecurity(snap) {
  const checks = [];
  const push = (name, verdict, detail = '') => checks.push({ name, verdict, detail });

  // Mint / freeze authority
  if (snap.mintAuthority === undefined) push('mint_authority', 'UNKNOWN', 'no data');
  else if (snap.mintAuthority === null) push('mint_authority', 'PASS', 'renounced');
  else push('mint_authority', 'REJECT', 'mintable');

  if (snap.freezeAuthority === undefined) push('freeze_authority', 'UNKNOWN', 'no data');
  else if (snap.freezeAuthority === null) push('freeze_authority', 'PASS', 'no freeze');
  else push('freeze_authority', 'REJECT', 'freezable');

  // Token-2022 extensions
  if ((snap.extensions || []).includes('permanent-delegate')) push('permanent_delegate', 'REJECT', 'permanent delegate present');
  else push('permanent_delegate', 'PASS', 'none');
  if ((snap.extensions || []).includes('transfer-fee')) push('transfer_fee', 'REJECT', 'transfer fee extension');
  else push('transfer_fee', 'PASS', 'none');

  // Liquidity
  if (snap.liquidityUsd == null) push('liquidity', 'UNKNOWN', 'missing');
  else if (snap.liquidityUsd < 10000) push('liquidity', 'REJECT', `low liq $${snap.liquidityUsd}`);
  else push('liquidity', 'PASS', `$${snap.liquidityUsd}`);

  if (snap.lpBurned === true || snap.lpLocked === true) push('lp_status', 'PASS', 'burned/locked');
  else if (snap.lpBurned === false && snap.lpLocked === false) push('lp_status', 'REJECT', 'LP unlocked');
  else push('lp_status', 'UNKNOWN', 'lp status unknown');

  // Holders
  if (snap.top10Pct == null) push('holders', 'UNKNOWN', 'missing holder data');
  else if (snap.top10Pct > 40) push('holders', 'REJECT', `top10 ${snap.top10Pct}%`);
  else push('holders', 'PASS', `top10 ${snap.top10Pct}%`);
  if (snap.devPct != null && snap.devPct > 8) push('dev_wallet', 'REJECT', `dev ${snap.devPct}%`);
  else if (snap.devPct == null) push('dev_wallet', 'UNKNOWN', 'no dev data');
  else push('dev_wallet', 'PASS', `dev ${snap.devPct}%`);

  // Sell-route verification (§15 exit verification)
  if (snap.sellRoute === 'NO_ROUTE') push('sell_route', 'REJECT', 'NO_ROUTE');
  else if (snap.sellRoute === 'EXCESSIVE_IMPACT') push('sell_route', 'REJECT', 'excessive impact');
  else if (snap.sellRoute === 'OK') push('sell_route', 'PASS', 'routable');
  else push('sell_route', 'UNKNOWN', 'not verified');

  // RugCheck explicit rug flag — independent indexer verdict, hard reject.
  if (snap.rugged === true) push('rugged_flag', 'REJECT', 'rugcheck: rugged');
  else push('rugged_flag', 'PASS', 'not flagged');

  const rejects = checks.filter(c => c.verdict === 'REJECT').length;
  const unknowns = checks.filter(c => c.verdict === 'UNKNOWN').length;
  const passes = checks.filter(c => c.verdict === 'PASS').length;
  const score = Math.round((passes / checks.length) * 100);
  const byName = Object.fromEntries(checks.map(c => [c.name, c.verdict]));

  let verdict = 'PASS';
  if (rejects > 0) verdict = 'REJECT';
  else if (unknowns > 0) verdict = 'UNKNOWN';

  // Critical bar: authorities renounced + real liquidity + proven sell route.
  // UNKNOWN here (no data) is NOT a pass. Non-critical UNKNOWNs (dev wallet,
  // LP lock status, insider clusters) may qualify for PAPER-only conditional.
  const criticalNames = ['mint_authority', 'freeze_authority', 'liquidity', 'sell_route'];
  const criticalPass = criticalNames.every(n => byName[n] === 'PASS');

  return { verdict, score, checks, hardReject: rejects > 0, criticalPass, rejects, unknowns };
}

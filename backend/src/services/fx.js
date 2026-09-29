// Real USD/IDR rate (for dual-currency display). Free no-key sources, cached 12h.
// Primary $ display, small Rp equivalent — rate labeled with date+source, never hardcoded silently.
import { kvGet, kvSet } from '../db.js';

async function fetchRate() {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD', { signal: ctrl.signal });
    if (r.ok) {
      const j = await r.json();
      if (j?.rates?.IDR) return { usdIdr: Number(j.rates.IDR), date: j.time_last_update_utc || new Date().toUTCString(), source: 'open.er-api' };
    }
    throw new Error('no IDR');
  } catch {
    const r2 = await fetch('https://api.frankfurter.app/latest?from=USD&to=IDR', { signal: ctrl.signal });
    if (!r2.ok)     throw new Error('fx_fail');
    const j2 = await r2.json();
    if (!j2?.rates?.IDR) throw new Error('fx_fail');
    return { usdIdr: Number(j2.rates.IDR), date: j2.date, source: 'frankfurter' };
  } finally { clearTimeout(to); }
}

export async function getFx() {
  const cached = kvGet('fx', null);
  if (cached && Date.now() - cached.ts < 12 * 3600e3) return cached;
  try {
    const live = await fetchRate();
    const out = { ...live, ts: Date.now() };
    kvSet('fx', out);
    return out;
  } catch {
    if (cached) return { ...cached, stale: true };
    return { usdIdr: 16500, date: null, source: 'fallback', ts: Date.now(), stale: true };
  }
}

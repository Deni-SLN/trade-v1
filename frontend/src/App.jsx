import React, { useEffect, useState, useCallback } from 'react';
import './styles.css';

const NAV = ['Overview','Performance','Live Market','Trades','Token Intelligence','Shadow Tracker','Strategy & Rules','Risk & Limits','Wallet','Profit Vault','System Engine','Settings'];
const api = (p, o) => fetch('/api' + p, { headers: { 'Content-Type': 'application/json' }, ...(o || {}) }).then(r => r.json());
const fmtRp = (n) => 'Rp' + Math.round(n ?? 0).toLocaleString('id-ID');
const fmtCompactRp = (n) => {
  const a = Math.abs(n ?? 0);
  if (a >= 1e9) return 'Rp' + (+((n / 1e9).toFixed(2))) + ' M';
  if (a >= 1e6) return 'Rp' + (+((n / 1e6).toFixed(1))) + ' jt';
  if (a >= 1e3) return 'Rp' + (+((n / 1e3).toFixed(1))) + ' rb';
  return 'Rp' + Math.round(n ?? 0);
};
const fmtUsd = (n) => {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a !== 0 && (a >= 1e6 || a < 1e-4)) return '$' + Number(n).toExponential(2);
  if (a < 1) return '$' + Number(n).toPrecision(3);
  return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
};
const fmtTs = (ts) => new Date(ts).toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit' });

// ---- dual currency: $ primary, small Rp at today's real rate (or swapped) ----
const FxCtx = React.createContext({ rate: 16500, date: null, stale: true, mode: '$', setMode: () => {} });
const useFx = () => React.useContext(FxCtx);
const fmtUSD = (idr, rate) => {
  const u = (idr ?? 0) / (rate || 16500);
  const a = Math.abs(u);
  if (a >= 1000) return '$' + u.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  if (a >= 1) return '$' + u.toFixed(2);
  return '$' + u.toPrecision(3);
};
// Big primary + small secondary. Token prices (already USD) keep using fmtUsd.
function Money({ idr, color }) {
  const { rate, mode } = useFx();
  const us = fmtUSD(idr, rate);
  const rp = (idr == null ? '—' : 'Rp' + Math.round(idr).toLocaleString('id-ID'));
  const big = mode === '$' ? us : rp;
  const small = mode === '$' ? rp : us;
  return <span style={color ? { color } : undefined}><span className="mono" style={{ fontWeight: 700 }}>{big}</span>{' '}<span className="mono" style={{ fontSize: '0.74em', color: '#8b98ad' }}>{small}</span></span>;
}
// Two-line table cell: $ over tiny Rp (or swapped).
function CellMoney({ idr }) {
  const { rate, mode } = useFx();
  const us = fmtUSD(idr, rate);
  const rp = (idr == null ? '—' : 'Rp' + Math.round(idr).toLocaleString('id-ID'));
  const neg = (idr ?? 0) < 0;
  return <span><span className={neg ? 'down' : 'up'}>{mode === '$' ? us : rp}</span><br /><span style={{ fontSize: '0.82em', color: '#5b6b82' }}>{mode === '$' ? rp : us}</span></span>;
}
const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + 'd lalu';
  if (s < 3600) return Math.floor(s / 60) + 'm lalu';
  if (s < 86400) return Math.floor(s / 3600) + 'j lalu';
  return Math.floor(s / 86400) + 'h lalu';
};

function smoothPath(pts) {
  if (pts.length < 3) return pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

// Balance-history chart in the style of the reference terminal:
// smooth curve riding profit, gradient fill, current-value callout,
// HWM dashed line, drawdown tint, per-trade PnL bars along the bottom.
function EquityChart({ data, bars, height = 230 }) {
  const { rate: eqRate } = useFx();
  if (!data || data.length < 2) return <div className="mono" style={{ color: '#8b98ad', padding: '28px 0', textAlign: 'center' }}>belum ada histori — jalankan ENGINE + SCAN, kurva naik-turun mengikuti profit</div>;
  const W = 760, H = height, L = 68, R = 92, T = 14, XB = 22, HB = 34;
  const plotB = H - XB - HB;
  const vals = data.flatMap(d => [d.equity, d.hwm]);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (max - min < 1) { max += 1; min -= 1; }
  const pad = (max - min) * 0.1; min -= pad; max += pad;
  const X = (i) => L + (i / (data.length - 1)) * (W - L - R);
  const Y = (v) => T + (1 - (v - min) / (max - min)) * (plotB - T);
  const pts = data.map((d, i) => [X(i), Y(d.equity)]);
  const eq = smoothPath(pts);
  const hwmLine = data.map((d, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(d.hwm).toFixed(1)}`).join(' ');
  const area = `${eq} L${X(data.length - 1).toFixed(1)},${plotB.toFixed(1)} L${X(0).toFixed(1)},${plotB.toFixed(1)} Z`;
  const ticks = [0, 1, 2, 3].map(i => min + ((max - min) * i) / 3);
  const xTicks = [0, 1, 2, 3, 4].map(i => Math.round(((data.length - 1) * i) / 4));
  let dd = '';
  for (let i = 0; i < data.length - 1; i++) {
    const a = data[i], b = data[i + 1];
    if (a.equity < a.hwm || b.equity < b.hwm) {
      dd += `M${X(i).toFixed(1)},${Y(a.equity).toFixed(1)} L${X(i + 1).toFixed(1)},${Y(b.equity).toFixed(1)} L${X(i + 1).toFixed(1)},${Y(b.hwm).toFixed(1)} L${X(i).toFixed(1)},${Y(a.hwm).toFixed(1)} Z `;
    }
  }
  const last = data[data.length - 1];
  const up = last.equity >= data[0].equity;
  // bottom PnL bars share the time domain
  const t0 = data[0].ts, t1 = data[data.length - 1].ts;
  const span = Math.max(1, t1 - t0);
  const TX = (ts) => L + ((ts - t0) / span) * (W - L - R);
  const list = (bars || []).filter(b => b.ts >= t0 - span && b.ts <= t1 + span).slice(-80);
  const maxAbs = Math.max(1, ...list.map(b => Math.abs(b.pnl || 0)));
  const stripT = plotB + 8, stripB = H - XB - 2, stripM = (stripT + stripB) / 2;
  const gid = 'eqg' + Math.abs(Math.round(min));
  const stroke = up ? '#34d399' : '#f87171';
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.4" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0.03" />
          </linearGradient>
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={L} y1={Y(t)} x2={W - R} y2={Y(t)} stroke="#141c2a" strokeWidth="1" strokeDasharray="2 4" />
            <text x={L - 7} y={Y(t) + 3.5} textAnchor="end" fontSize="10.5" fill="#8b98ad" fontFamily="JetBrains Mono, monospace">{fmtCompactRp(t)}</text>
          </g>
        ))}
        <path d={dd} fill="#ef4444" opacity="0.14" />
        <path d={area} fill={`url(#${gid})`} />
        <path d={hwmLine} fill="none" stroke="#22d3ee" strokeWidth="1.1" strokeDasharray="6 4" opacity="0.75" />
        <path d={eq} fill="none" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" />
        <circle cx={X(data.length - 1)} cy={Y(last.equity)} r="4" fill={stroke} stroke="#06090f" strokeWidth="2" />
        {/* right callout: BALANCE + current value */}
        <text x={W - R + 8} y={T + 12} fontSize="9.5" fill="#5b6b82" letterSpacing="1.5">BALANCE</text>
        <text x={W - R + 8} y={T + 30} fontSize="14" fill={stroke} fontWeight="800" fontFamily="JetBrains Mono, monospace">{fmtCompactRp(last.equity)}</text>
        <text x={W - R + 8} y={T + 45} fontSize="10" fill="#67e8f9" fontFamily="JetBrains Mono, monospace">HWM {fmtCompactRp(last.hwm)}</text>
        {/* bottom per-trade PnL bars */}
        <line x1={L} y1={stripM} x2={W - R} y2={stripM} stroke="#1e2a3d" />
        {list.map((b, i) => {
          const h = Math.max(1.5, (Math.abs(b.pnl || 0) / maxAbs) * ((stripB - stripT) / 2 - 1));
          const gain = (b.pnl || 0) >= 0;
          return <rect key={i} x={TX(b.ts) - 2.2} y={gain ? stripM - h : stripM} width="4.4" height={h} rx="1" fill={gain ? '#22c55e' : '#ef4444'} opacity="0.85"><title>{(gain ? '+' : '') + fmtUSD(b.pnl, eqRate)} · {new Date(b.ts).toLocaleString('id-ID')}</title></rect>;
        })}
        {xTicks.map((i, k) => (
          <text key={k} x={X(i)} y={H - 7} textAnchor="middle" fontSize="10" fill="#5b6b82" fontFamily="JetBrains Mono, monospace">{fmtTs(data[i].ts)}</text>
        ))}
        <title>Equity naik-turun mengikuti profit · bar bawah = PnL per trade</title>
      </svg>
      <div className="mono" style={{ display: 'flex', gap: 16, fontSize: 10.5, color: '#8b98ad', marginTop: 2 }}>
        <span><span style={{ color: stroke }}>━━</span> equity</span>
        <span><span style={{ color: '#22d3ee' }}>┄┄</span> HWM</span>
        <span><span className="up">▮</span><span className="down">▮</span> PnL per trade</span>
      </div>
    </div>
  );
}

function Scatter({ data, x, y, xlabel = 'X', ylabel = 'Y' }) {
  if (!data?.length) return <div className="mono" style={{ color: '#8b98ad', padding: '28px 0', textAlign: 'center' }}>belum ada data</div>;
  const W = 480, H = 220, L = 52, R = 12, T = 10, B = 34;
  const xs = data.map(d => +d[x] || 0), ys = data.map(d => +d[y] || 0);
  let x0 = Math.min(...xs, 0), x1 = Math.max(...xs, 0), y0 = Math.min(...ys, 0), y1 = Math.max(...ys, 0);
  if (x1 - x0 < 1e-9) { x1 += 1; x0 -= 1; }
  if (y1 - y0 < 1e-9) { y1 += 1; y0 -= 1; }
  const X = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R);
  const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const ticks = (a, b) => [0, 1, 2, 3, 4].map(i => a + ((b - a) * i) / 4);
  const pos = ys.filter(v => v >= 0).length;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }}>
        {ticks(y0, y1).map((t, i) => (
          <g key={i}>
            <line x1={L} y1={Y(t)} x2={W - R} y2={Y(t)} stroke="#16202f" />
            <text x={L - 5} y={Y(t) + 3.5} textAnchor="end" fontSize="9.5" fill="#8b98ad" fontFamily="JetBrains Mono, monospace">{+t.toFixed(1)}</text>
          </g>
        ))}
        {ticks(x0, x1).map((t, i) => (
          <text key={i} x={X(t)} y={H - 18} textAnchor="middle" fontSize="9.5" fill="#5b6b82" fontFamily="JetBrains Mono, monospace">{+t.toFixed(1)}</text>
        ))}
        <line x1={L} y1={Y(0)} x2={W - R} y2={Y(0)} stroke="#475569" strokeWidth="1.2" />
        {X(0) > L && X(0) < W - R && <line x1={X(0)} y1={T} x2={X(0)} y2={H - B} stroke="#475569" strokeWidth="1" />}
        {data.slice(0, 200).map((d, i) => (
          <circle key={i} cx={X(+d[x])} cy={Y(+d[y])} r="3.4" fill={(+d[y] || 0) >= 0 ? '#22c55e' : '#ef4444'} opacity="0.75">
            <title>{xlabel}: {(+d[x]).toFixed(2)} · {ylabel}: {(+d[y]).toFixed(2)}{d.label ? ' · ' + d.label : ''}</title>
          </circle>
        ))}
        <text x={(L + W - R) / 2} y={H - 4} textAnchor="middle" fontSize="10" fill="#8b98ad">{xlabel}</text>
        <text x={10} y={(T + H - B) / 2} textAnchor="middle" fontSize="10" fill="#8b98ad" transform={`rotate(-90 10 ${(T + H - B) / 2})`}>{ylabel}</text>
      </svg>
      <div className="mono" style={{ fontSize: 10.5, color: '#8b98ad' }}>n={data.length} · positif {((pos / data.length) * 100).toFixed(0)}% (<span className="up">●</span>) · negatif {(((data.length - pos) / data.length) * 100).toFixed(0)}% (<span className="down">●</span>)</div>
    </div>
  );
}

function FrictionBar({ f }) {
  const { rate, mode } = useFx();
  const dual = (v) => mode === '$' ? `${fmtUSD(v, rate)} · Rp${Math.round(v).toLocaleString('id-ID')}` : `Rp${Math.round(v).toLocaleString('id-ID')} · ${fmtUSD(v, rate)}`;
  if (!f || (f.gross ?? 0) <= 0) return null;
  const segs = [
    ['Net', f.net, '#22c55e'], ['DEX', f.dexFee, '#f97316'], ['Priority', f.priorityFee, '#eab308'],
    ['Route', f.jupiterRoute, '#3b82f6'], ['Slippage', f.slippage, '#ef4444'], ['MEV', f.mev, '#a855f7']
  ].filter(s => s[1] > 0);
  const tot = segs.reduce((a, s) => a + s[1], 0) || 1;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', height: 16, borderRadius: 4, overflow: 'hidden', border: '1px solid #1b2433' }}>
        {segs.map(([k, v, c]) => <div key={k} title={`${k}: ${dual(v)}`} style={{ width: (v / tot * 100) + '%', background: c }} />)}
      </div>
      <div className="mono" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 10.5, color: '#8b98ad', marginTop: 5 }}>
        {segs.map(([k, v, c]) => <span key={k} title={dual(v)}><span style={{ display: 'inline-block', width: 8, height: 8, background: c, borderRadius: 2 }} /> {k} {mode === '$' ? fmtUSD(v, rate) : 'Rp' + Math.round(v).toLocaleString('id-ID')}</span>)}
      </div>
    </div>
  );
}

function usePoll(fn, ms, deps = []) {
  const [data, setData] = useState(null);
  const load = useCallback(async () => { try { setData(await fn()); } catch {} }, deps);
  useEffect(() => { load(); const t = setInterval(load, ms); return () => clearInterval(t); }, [load, ms]);
  return [data, load];
}



function LivePnlChip() {
  const [pnl] = usePoll(() => api('/pnl/live'), 5000);
  const { rate, mode } = useFx();
  if (!pnl || !pnl.count) return <span style={{ color: '#5b6b82' }}>PNL LIVE: flat (0 open)</span>;
  const v = pnl.total_unrealized ?? 0;
  const neg = v < 0;
  return (
    <span title="Unrealized PnL posisi open, quote real-time per 5 detik">
      PNL LIVE <b className={neg ? 'down' : 'up'}>{neg ? '−' : '+'}{mode === '$' ? fmtUSD(Math.abs(v), rate) : 'Rp' + Math.abs(Math.round(v)).toLocaleString('id-ID')}</b>{' '}
      <span style={{ color: '#5b6b82' }}>({pnl.count} open{!pnl.positions.every(p => p.live) ? ' · quote pending' : ''})</span>
    </span>
  );
}

function FxChip() {
  const { rate, date, stale, mode, setMode } = useFx();
  return (
    <span title={date ? `Kurs ${date} — tap $/Rp untuk ganti primer` : 'Kurs loading'}>
      <button className="mode-btn paper" style={{ padding: '2px 8px', fontSize: 10 }} onClick={() => setMode(mode === '$' ? 'Rp' : '$')}>{mode === '$' ? '$ ⇄ Rp' : 'Rp ⇄ $'}</button>{' '}
      $1 = Rp{Math.round(rate).toLocaleString('id-ID')}{stale ? '*' : ''}
    </span>
  );
}

export default function App() {
  const [nav, setNav] = useState('Overview');
  const [drawer, setDrawer] = useState(false);
  const [status, setStatus] = useState(null);
  const [kpi, setKpi] = useState(null);
  const [showLiveGate, setShowLiveGate] = useState(null);
  const [showStop, setShowStop] = useState(false);
  const [msg, setMsg] = useState('');
  const [fx, setFx] = useState({ rate: 16500, date: null, source: 'loading…', stale: true });
  const [fxMode, setFxMode] = useState(() => { try { return localStorage.getItem('sofia-fx-mode') || '$'; } catch { return '$'; } });
  useEffect(() => {
    const load = async () => { try { setFx(await api('/fx')); } catch {} };
    load();
    const t = setInterval(load, 6 * 3600e3);
    return () => clearInterval(t);
  }, []);
  const changeFxMode = (m) => { setFxMode(m); try { localStorage.setItem('sofia-fx-mode', m); } catch {} };
  const fxCtx = { ...fx, mode: fxMode, setMode: changeFxMode };

  const loadStatus = useCallback(async () => {
    try {
      const s = await api('/status');
      setStatus(s);
      const k = await api('/kpi');
      setKpi(k);
    } catch {}
  }, []);
  useEffect(() => { loadStatus(); const t = setInterval(loadStatus, 5000); return () => clearInterval(t); }, [loadStatus]);

  const running = status?.engine === 'RUNNING';
  const live = status?.mode === 'LIVE';

  const doStart = async () => {
    const r = await api('/engine/start', { method: 'POST', body: '{}' });
    if (r.ok) setMsg('ENGINE RUNNING');
    else if (r.reason === 'KILL_SWITCH_ENGAGED') setMsg('START BLOCKED: kill-switch masih ENGAGED — klik RELEASE KILL-SWITCH di header (atau Risk & Limits → RELEASE), lalu START lagi.');
    else setMsg('START BLOCKED: ' + (r.reason || 'check preflight') + (r.hint ? ' — ' + r.hint : ''));
    loadStatus();
  };
  const releaseKill = async () => {
    await api('/kill/release', { method: 'POST', body: '{}' });
    setMsg('KILL RELEASED — engine STOPPED & aman. Sekarang klik START ENGINE.');
    loadStatus();
  };
  const doStop = async (mode) => {
    await api('/engine/stop', { method: 'POST', body: JSON.stringify({ mode }) });
    setShowStop(false); setMsg('ENGINE ' + mode.toUpperCase()); loadStatus();
  };
  const askMode = async (target) => {
    const r = await api('/mode/request', { method: 'POST', body: JSON.stringify({ target }) });
    if (target === 'LIVE') {
      if (r.needExplicitConfirm) setShowLiveGate({ gates: r.gates || [] });
      else setShowLiveGate({ gates: [], blocked: r.reason, failed: r.failed });
    } else {
      if (r.ok) {
        const c = await api('/mode/confirm', { method: 'POST', body: JSON.stringify({ target }) });
        setMsg(c.ok ? 'MODE → PAPER' : 'MODE SWITCH BLOCKED: ' + c.reason);
        loadStatus();
      } else setMsg('STOP ENGINE BEFORE SWITCHING MODE');
    }
  };
  const confirmLive = async () => {
    const c = await api('/mode/confirm', { method: 'POST', body: JSON.stringify({ target: 'LIVE' }) });
    setShowLiveGate(null);
    setMsg(c.ok ? 'LIVE TRADE ACTIVATED — REAL CAPITAL' : 'LIVE BLOCKED: ' + (c.reason || c.failed?.join(',')));
    loadStatus();
  };
  const kill = async () => { await api('/kill', { method: 'POST', body: JSON.stringify({ reason: 'manual header' }) }); loadStatus(); };

  return (
    <FxCtx.Provider value={fxCtx}>
    <div className="app">
      <header>
        <button className="hamburger" onClick={() => setDrawer(true)} aria-label="Menu">☰</button>
        <div className="brand">SOFIA MEME BOT<small>SOLANA · QUANT TERMINAL · V1.0</small></div>
        <div>
          <button className={`mode-btn paper ${!live ? 'active' : ''}`} onClick={() => askMode('PAPER')}>PAPER TRADE</button>{' '}
          <button className={`mode-btn live ${live ? 'active' : ''}`} onClick={() => askMode('LIVE')}>LIVE TRADE</button>
          <div style={{ fontSize: 10, color: live ? '#f87171' : '#67e8f9', marginTop: 4, fontWeight: 700, letterSpacing: 1 }}>
            {live ? 'REAL CAPITAL · REAL EXECUTION' : 'REAL MARKET DATA · VIRTUAL CAPITAL'}
          </div>
        </div>
        <div>
          {!running
            ? <button className="engine-btn" onClick={doStart}>● START ENGINE</button>
            : <button className="engine-btn stop" onClick={() => setShowStop(true)}>■ STOP ENGINE</button>}
          <div className="mono" style={{ fontSize: 11, marginTop: 4 }}>
            MODE <b style={{ color: live ? '#f87171' : '#67e8f9' }}>{status?.mode || '…'}</b> · ENGINE{' '}
            <b style={{ color: running ? '#4ade80' : status?.engine === 'PAUSED' ? '#facc15' : '#8b98ad' }}>{status?.engine || '…'}</b>
          </div>
          {status?.kill?.engaged && (
            <div style={{ marginTop: 6, background: '#2a0a0a', border: '1px solid #7f1d1d', borderRadius: 4, padding: '5px 8px' }}>
              <div className="mono" style={{ fontSize: 10, color: '#f87171', fontWeight: 800, letterSpacing: 1 }}>⛔ KILL ENGAGED — START diblokir</div>
              <button className="btn go" style={{ marginTop: 5, width: '100%' }} onClick={releaseKill}>RELEASE KILL-SWITCH</button>
            </div>
          )}
        </div>
        <div style={{ flex: 1 }}>
          <div className="mono" style={{ fontSize: 15 }}>
            SOL <b>${status?.sol?.price?.toFixed(2) ?? '…'}</b>{' '}
            <span className={status?.sol?.chg24 >= 0 ? 'up' : 'down'}>{status?.sol?.chg24 >= 0 ? '+' : ''}{status?.sol?.chg24?.toFixed(2)}%</span>{' '}
            {live ? <span className="live-banner">REAL CAPITAL ACTIVE</span> : <span className="paper-banner">PAPER · NO REAL TX</span>}
          </div>
          <div className="status-row mono" style={{ marginTop: 6 }}>
            <span><span className="dot" style={{ background: status?.services?.jupiter === 'UP' ? '#22c55e' : '#ef4444' }} />Jupiter <b>{status?.services?.jupiter}</b></span>
            <span><span className="dot" style={{ background: status?.services?.rpc === 'UP' ? '#22c55e' : '#ef4444' }} />RPC <b>{status?.rpcLatency}ms</b></span>
            <span><span className="dot" style={{ background: '#22c55e' }} />Market <b>{status?.services?.market}</b></span>
            <span>Open <b>{status?.openPositions ?? 0}</b></span>
            <span>Risk <b>{status?.circuit}</b></span>
            <LivePnlChip />
            <FxChip />
            {msg && <span style={{ color: '#facc15' }}>{msg}</span>}
          </div>
        </div>
        <button className="kill-btn" onClick={kill} title="Emergency stop everywhere">KILL ⏻</button>
      </header>

      <aside>
        {NAV.map(n => <div key={n} className={`nav-item ${nav === n ? 'active' : ''}`} onClick={() => setNav(n)}>{n}</div>)}
        <div className="mono" style={{ fontSize: 10, color: '#5b6b82', padding: 10 }}>ENGINE: {status?.engine}<br />MODE: {status?.mode}<br />RPC: {status?.rpcLatency}ms</div>
      </aside>

      {drawer && (
        <>
          <div className="drawer-bg" onClick={() => setDrawer(false)} />
          <div className="drawer">
            <div className="mono" style={{ fontSize: 10, letterSpacing: 2, color: '#5b6b82', padding: '4px 12px 10px' }}>SOFIA · NAVIGASI</div>
            {NAV.map(n => <div key={n} className={`nav-item ${nav === n ? 'active' : ''}`} onClick={() => { setNav(n); setDrawer(false); }}>{n}</div>)}
            <div className="mono" style={{ fontSize: 11, color: '#5b6b82', padding: 12 }}>ENGINE: {status?.engine}<br />MODE: {status?.mode}</div>
          </div>
        </>
      )}

      <main>
        {nav === 'Overview' && <Overview kpi={kpi} status={status} reload={loadStatus} />}
        {nav === 'Performance' && <Performance />}
        {nav === 'Live Market' && <LiveMarket status={status} />}
        {nav === 'Trades' && <Trades />}
        {nav === 'Token Intelligence' && <Intelligence />}
        {nav === 'Shadow Tracker' && <Shadow />}
        {nav === 'Strategy & Rules' && <Strategy />}
        {nav === 'Risk & Limits' && <Risk reload={loadStatus} />}
        {nav === 'Wallet' && <Wallet />}
        {nav === 'Profit Vault' && <Vault />}
        {nav === 'System Engine' && <System reload={loadStatus} />}
        {nav === 'Settings' && <Settings />}
      </main>

      {showStop && (
        <div className="modal-bg" onClick={() => setShowStop(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3 className="mono">STOP ENGINE</h3>
            <button className="btn" style={{ width: '100%', margin: '6px 0' }} onClick={() => doStop('new_entries')}>○ Stop New Entries — existing tetap dikelola</button>
            <button className="btn" style={{ width: '100%', margin: '6px 0' }} onClick={() => doStop('complete')}>○ Stop Completely — hentikan loop + execution baru</button>
            <button className="btn danger" style={{ width: '100%', margin: '6px 0' }} onClick={() => doStop('emergency')}>○ Emergency Stop — hentikan semua + flag exit (confirm)</button>
            <button className="btn" onClick={() => setShowStop(false)}>Cancel</button>
          </div>
        </div>
      )}
      {showLiveGate && (
        <div className="modal-bg" onClick={() => setShowLiveGate(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3 className="mono" style={{ color: '#f87171' }}>LIVE TRADING ACTIVATION</h3>
            {showLiveGate.blocked
              ? <><p>Blocked: <b>{showLiveGate.blocked}</b></p><ul>{(showLiveGate.failed || []).map((f, i) => <li key={i}>{f}</li>)}
                </ul><p className="mono" style={{ fontSize: 11, color: '#8b98ad' }}>Requirements: Engine STOPPED · wallet connected · Jupiter+RPC healthy · kill switch available · risk limits valid.</p></>
              : <><p className="mono">Wallet: <b>[masked]</b> · MaxPos Rp25.000 · DailyLoss 6% · MaxOpen 4 · Slip 500bps · Emergency Stop Enabled</p>
                <ul>{showLiveGate.gates.map((g, i) => <li key={i}>[{(g[1] ?? g.pass) ? '✓' : '✗'}] {g[0] ?? g.name}</li>)}</ul></>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={() => setShowLiveGate(null)}>CANCEL</button>
              {!showLiveGate.blocked && <button className="btn danger" onClick={confirmLive}>ENABLE LIVE TRADE</button>}
            </div>
          </div>
        </div>
      )}
    </div>
    </FxCtx.Provider>
  );
}

function KpiCards({ kpi }) {
  const k = kpi || {};
  const cards = [
    ['Total Equity', <Money idr={k.equity} />, '#fff'],
    ['Net PnL', <Money idr={k.netPnl} />, (k.netPnl ?? 0) >= 0 ? '#4ade80' : '#f87171'],
    ['ROI', ((k.roi ?? 0) >= 0 ? '+' : '') + (k.roi ?? 0) + '%', (k.roi ?? 0) >= 0 ? '#4ade80' : '#f87171'],
    ['Win Rate', (k.winRate ?? 0) + '%', '#67e8f9'],
    ['Profit Factor', k.profitFactor ?? 0, '#fff'],
    ['Max Drawdown', (k.maxDrawdown ?? 0) + '%', '#f87171'],
    ['Total Trades', k.totalTrades ?? 0, '#fff'],
    ['Expectancy', '+' + (k.expectancy ?? 0) + 'R', '#4ade80']
  ];
  return <div className="grid-kpi">{cards.map(([t, v, c]) => <div className="card" key={t}><h4>{t.toUpperCase()}</h4><div className="v" style={{ color: c }}>{v}</div></div>)}</div>;
}

function Overview({ kpi, status, reload }) {
  const [equity] = usePoll(() => api('/equity'), 15000);
  const [intel] = usePoll(() => api('/intelligence'), 15000);
  const [events] = usePoll(() => api('/engine/events'), 10000);
  const [trades] = usePoll(() => api('/trades?limit=200'), 15000);
  const bars = (trades || []).filter(t => t.state === 'CLOSED' && t.exit_ts).map(t => ({ ts: t.exit_ts, pnl: t.pnl_net }));
  return (
    <>
      <KpiCards kpi={kpi} />
      <div className="cols2">
        <div className="panel"><h3>BALANCE HISTORY</h3><EquityChart data={equity} bars={bars} />
          <div className="mono" style={{ fontSize: 11, color: '#8b98ad' }}>Kurva naik-turun mengikuti profit · di bawah HWM = drawdown.</div></div>
        <div className="panel"><h3>TOKEN INTELLIGENCE — LAST 24H</h3>
          <div className="cols3 mono" style={{ textAlign: 'center' }}>
            {['candidates', 'securityPass', 'strategyPass', 'entries', 'rejected'].map(k => (
              <div className="card" key={k}><h4>{k.toUpperCase()}</h4><div className="v">{intel?.[k] ?? '…'}</div></div>))}
          </div>
          <div className="mono" style={{ fontSize: 11, marginTop: 8, color: '#8b98ad' }}>SecPass {intel?.securityPassRate}% · StratPass {intel?.strategyPassRate}% · Entry {intel?.entryRate}%</div>
          <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <ScanButton status={status} reload={reload} />
            <span className="mono" style={{ fontSize: 10.5, color: '#8b98ad' }}>
              {status?.discovery?.count > 0
                ? `feed: ${status.discovery.count} token real · dexscreener`
                : 'feed: menunggu discovery real'}
            </span>
          </div>
        </div>
      </div>
      <div className="panel"><h3>RISK SNAPSHOT</h3><RiskInline /></div>
      <CoinFlow />
      <div className="panel"><h3>ENGINE EVENTS (AUDIT)</h3>
        <table><thead><tr><th>TS</th><th>EVENT</th><th>DETAIL</th></tr></thead><tbody>
          {(events || []).slice(0, 12).map(e => <tr key={e.id}><td>{new Date(e.ts).toLocaleTimeString()}</td><td>{e.event}</td><td>{e.detail}</td></tr>)}
        </tbody></table></div>
    </>
  );
}

function Performance() {
  const [equity] = usePoll(() => api('/equity'), 15000);
  const [rolling] = usePoll(() => api('/analytics/rolling'), 15000);
  const [maemfe] = usePoll(() => api('/analytics/maemfe'), 15000);
  const [exits] = usePoll(() => api('/analytics/exits'), 15000);
  const [friction] = usePoll(() => api('/analytics/friction'), 15000);
  const [hold] = usePoll(() => api('/analytics/hold'), 15000);
  const [mc, setMc] = useState(null);
  const { rate: mcRate } = useFx();
  const [tradesPf] = usePoll(() => api('/trades?limit=200'), 15000);
  const barsPf = (tradesPf || []).filter(t => t.state === 'CLOSED' && t.exit_ts).map(t => ({ ts: t.exit_ts, pnl: t.pnl_net }));
  return (
    <>
      <div className="panel"><h3>BALANCE HISTORY · 1D 1W 1M 3M ALL</h3><EquityChart data={equity} bars={barsPf} /></div>
      <div className="cols2">
        <div className="panel"><h3>ROLLING PERFORMANCE (50/100/200)</h3>
          <table><thead><tr><th>WIN</th><th>N</th><th>WIN%</th><th>NET</th></tr></thead><tbody>
            {(rolling?.windows || []).map(w => <tr key={w.window}><td>{w.window}</td><td>{w.n}</td><td>{w.winRate}%</td><td><CellMoney idr={w.net} /></td></tr>)}
          </tbody></table></div>
        <div className="panel"><h3>EXIT ATTRIBUTION</h3>
          <table><thead><tr><th>REASON</th><th>N</th><th>PNL</th></tr></thead><tbody>
            {(exits || []).map(e => <tr key={e.exit_reason}><td>{e.exit_reason}</td><td>{e.n}</td><td><CellMoney idr={e.pnl} /></td></tr>)}
          </tbody></table></div>
      </div>
      <div className="cols2">
        <div className="panel"><h3>MAE / MFE MATRIX</h3><Scatter data={(maemfe || []).map(t => ({ x: t.mae, y: t.mfe, label: t.symbol }))} x="x" y="y" xlabel="MAE % (adverse)" ylabel="MFE % (favorable)" />
          <div className="mono" style={{ fontSize: 11, color: '#8b98ad' }}>Kanan-atas = runner · kiri-atas = exit prematur.</div></div>
        <div className="panel"><h3>HOLD DURATION VS RETURN</h3><Scatter data={(hold || []).map(h => ({ x: (h.hold_secs || 0) / 60, y: h.ret }))} x="x" y="y" xlabel="menit" ylabel="return %" /></div>
      </div>
      <div className="cols2">
        <div className="panel"><h3>COST FRICTION: GROSS → NET</h3>
          {friction && <><FrictionBar f={friction} /><table><tbody>
            {[['Gross PnL', friction.gross], ['− DEX Fee', -friction.dexFee], ['− Priority Fee', -friction.priorityFee], ['− Jupiter Route', -friction.jupiterRoute], ['− Slippage', -friction.slippage], ['− MEV', -friction.mev], ['= Net PnL', friction.net]].map(([k, v]) => (
              <tr key={k}><td>{k}</td><td><CellMoney idr={v} /></td></tr>))}
          </tbody></table></>}</div>
        <div className="panel"><h3>MONTE CARLO (SCENARIO ONLY)</h3>
          <div style={{ display: 'flex', gap: 6 }}>
            {[1000, 5000, 10000].map(s => <button key={s} className="btn" onClick={() => api('/analytics/montecarlo?sims=' + s).then(setMc)}>{s.toLocaleString()}</button>)}
          </div>
          {mc && <div className="mono" style={{ marginTop: 8, fontSize: 12 }}>median {fmtUSD(mc.median, mcRate)} <span style={{ color: '#5b6b82' }}>Rp{Math.round(mc.median).toLocaleString('id-ID')}</span> · p5 {fmtUSD(mc.p5, mcRate)} · p95 {fmtUSD(mc.p95, mcRate)} · P(profit) {mc.probProfit}%<br /><span style={{ color: '#8b98ad' }}>{mc.note}</span></div>}
        </div>
      </div>
    </>
  );
}

function LiveMarket({ status }) {
  const [resp, setResp] = useState(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/market/tokens').then(r => r.json());
      setResp(r);
    } catch { setResp({ ok: false, error: 'network' }); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);
  const [q, setQ] = useState(null);
  const tokens = Array.isArray(resp) ? resp : [];
  return (
    <div className="panel"><h3>LIVE MARKET — REAL DISCOVERY (DEXSCREENER + ON-CHAIN RPC) · ENGINE {status?.engine}</h3>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn" onClick={load}>REFRESH</button>
        <span className="mono" style={{ fontSize: 10.5, color: '#8b98ad' }}>harga · likuiditas · volume · txns = data live · holder% = on-chain RPC · holder count/dev/LP-lock = UNKNOWN (jujur, tidak difake)</span>
      </div>
      {resp && !Array.isArray(resp) && (
        <div className="mono" style={{ marginTop: 8, padding: 10, background: '#2a0a0a', border: '1px solid #7f1d1d', borderRadius: 4, fontSize: 12 }}>
          FEED OFFLINE: {resp.error} — tidak ada data palsu ditampilkan. Cek koneksi lalu REFRESH.
        </div>
      )}
      <table style={{ marginTop: 8 }}><thead><tr><th>#</th><th>SYMBOL</th><th>HARGA</th><th>LIQ $</th><th>VOL24 $</th><th>BUY/SELL H24</th><th>5M%</th><th>TOP10</th><th>SRC</th><th>DEX</th><th>QUOTE</th></tr></thead><tbody>
        {tokens.map((t, i) => <tr key={t.mint}>
          <td>{i + 1}</td>
          <td><b style={{ color: '#fff' }}>{t.symbol}</b><br /><span title={t.mint} style={{ color: '#5b6b82', fontSize: 10 }}>{String(t.mint).slice(0, 6)}…{String(t.mint).slice(-4)}</span></td>
          <td>{fmtUsd(t.price)}</td>
          <td>{Math.round(t.liquidityUsd || 0).toLocaleString()}</td>
          <td>{Math.round(t.volume24hUsd || 0).toLocaleString()}</td>
          <td className={(t.buys ?? 0) >= (t.sells ?? 0) ? 'up' : 'down'}>{t.buys}/{t.sells}</td>
          <td className={(t.momentum5m ?? 0) >= 0 ? 'up' : 'down'}>{(+t.momentum5m || 0).toFixed(1)}%</td>
          <td>{t.top10Pct != null ? t.top10Pct + '%' : '?'}</td>
          <td><span className="tag paper">{t.source}</span></td>
          <td>{t.dexUrl ? <a href={t.dexUrl} target="_blank" rel="noreferrer" style={{ color: '#67e8f9' }}>↗</a> : '—'}</td>
          <td><button className="btn" onClick={async () => setQ(await api(`/market/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${t.mint}&amount=1000000`))}>JUP</button></td>
        </tr>)}
      </tbody></table>
      {q && <div className="mono" style={{ marginTop: 8, fontSize: 11 }}>jupiter: {q.ok ? `out=${q.outAmount} impact=${q.priceImpactBps}bps route=${q.route} ${q.latencyMs}ms` : 'NO QUOTE (' + (q.error || '?') + ')'}</div>}
    </div>
  );
}

function Trades() {
  const [trades] = usePoll(() => api('/trades?limit=100'), 8000);
  const [decisions] = usePoll(() => api('/decisions'), 10000);
  const [tab, setTab] = useState('trades');
  return (
    <>
      <div style={{ display: 'flex', gap: 6 }}><button className="btn" onClick={() => setTab('trades')}>TRADES</button><button className="btn" onClick={() => setTab('journal')}>JOURNAL (DECISIONS)</button></div>
      {tab === 'trades' ? (
        <div className="panel"><h3>TRADES — STATE: OPEN / CLOSED / EMERGENCY_EXIT</h3>
          <table><thead><tr><th>SYM</th><th>MODE</th><th>ENTRY</th><th>EXIT</th><th>PNL NET</th><th>EXIT REASON</th><th>STATE</th><th>CFG</th></tr></thead><tbody>
            {(trades || []).map(t => <tr key={t.id}><td>{t.symbol}</td><td><span className={`tag ${t.mode === 'LIVE' ? 'live' : 'paper'}`}>{t.mode}</span></td>
              <td>{t.entry_price != null ? fmtUsd(t.entry_price) : '—'}</td><td>{t.exit_price != null ? fmtUsd(t.exit_price) : '—'}</td>
              <td>{t.pnl_net == null ? 'OPEN' : <CellMoney idr={t.pnl_net} />}</td>
              <td>{t.exit_reason ?? '—'}</td><td>{t.state}</td><td>{(t.config_hash || '').slice(0, 8)}</td></tr>)}
          </tbody></table></div>
      ) : (
        <div className="panel"><h3>TRADING JOURNAL — EVERY DECISION AUDITED (§23)</h3>
          <table><thead><tr><th>TIME</th><th>MINT/SYM</th><th>MODE</th><th>SEC</th><th>STRAT</th><th>RISK</th><th>STATUS</th><th>CFG</th></tr></thead><tbody>
            {(decisions || []).slice(0, 60).map(d => <tr key={d.decision_id}><td>{new Date(d.ts).toLocaleTimeString()}</td><td>{d.symbol}</td><td>{d.mode}</td>
              <td><span className={`tag ${d.security_verdict === 'PASS' ? 'pass' : d.security_verdict === 'REJECT' ? 'reject' : 'unknown'}`}>{d.security_verdict} {d.security_score}</span></td>
              <td><span className="tag paper">{d.strategy_verdict} {d.strategy_score}</span></td>
              <td>{d.risk_verdict}:{d.risk_reason}</td><td>{d.status}</td><td>{(d.config_hash || '').slice(0, 8)}</td></tr>)}
          </tbody></table></div>
      )}
    </>
  );
}

function Intelligence() {
  const [intel] = usePoll(() => api('/intelligence'), 10000);
  const [decisions] = usePoll(() => api('/decisions'), 10000);
  return (
    <div className="panel"><h3>TOKEN INTELLIGENCE — PIPELINE: CANDIDATES → SEC → STRAT → ENTRY</h3>
      <div className="cols3 mono" style={{ textAlign: 'center' }}>
        {[['Candidates', intel?.candidates], ['Security Pass', intel?.securityPass], ['Strategy Pass', intel?.strategyPass], ['Paper Entries', intel?.entries], ['Rejected', intel?.rejected], ['Entry Rate', (intel?.entryRate ?? 0) + '%']].map(([k, v]) => (
          <div className="card" key={k}><h4>{k.toUpperCase()}</h4><div className="v">{v ?? '…'}</div></div>))}
      </div>
      <table style={{ marginTop: 10 }}><thead><tr><th>TIME</th><th>SYM</th><th>SEC</th><th>STRAT</th><th>RISK</th><th>OUTCOME</th></tr></thead><tbody>
        {(decisions || []).slice(0, 30).map(d => <tr key={d.decision_id}><td>{new Date(d.ts).toLocaleTimeString()}</td><td>{d.symbol}</td><td>{d.security_verdict} ({d.security_score})</td><td>{d.strategy_verdict} ({d.strategy_score})</td><td>{d.risk_verdict}</td><td>{d.status}</td></tr>)}
      </tbody></table>
    </div>
  );
}

function Shadow() {
  const [rows] = usePoll(() => api('/shadow'), 15000);
  return (
    <div className="panel"><h3>SHADOW TRACKER — REJECTED TOKEN OUTCOMES (15M/1H/24H)</h3>
      <div className="mono" style={{ fontSize: 11, color: '#8b98ad', marginBottom: 8 }}>Measures false negatives. MISSED_OPPORTUNITY is evaluation only — not a signal to trade unsafe tokens.</div>
      <table><thead><tr><th>SYM</th><th>REJECT REASON</th><th>+15M%</th><th>+1H%</th><th>+24H%</th><th>MAX UP</th><th>VERDICT</th></tr></thead><tbody>
        {(rows || []).map(s => <tr key={s.mint}><td>{s.symbol}</td><td>{s.reject_reason}</td><td>{(+s.p15).toFixed(1)}</td><td className={s.p60 >= 0 ? 'up' : 'down'}>{(+s.p60).toFixed(1)}</td><td>{(+s.p1440).toFixed(1)}</td><td className={s.max_upside > 100 ? 'up' : ''}>{(+s.max_upside).toFixed(1)}</td>
          <td><span className={`tag ${s.verdict === 'MISSED_OPPORTUNITY' ? 'wait' : 'pass'}`}>{s.verdict}</span></td></tr>)}
      </tbody></table>
    </div>
  );
}

function Strategy() {
  const [cfg] = usePoll(() => api('/config'), 30000);
  const [presets, reloadPresets] = usePoll(() => api('/configs'), 10000);
  const [presetMsg, setPresetMsg] = useState('');
  const [out, setOut] = useState(null);
  const [form, setForm] = useState({ liquidityUsd: 60000, top10Pct: 20, devPct: 2, sellRoute: 'OK', mintAuthority: null, lpBurned: true });
  return (
    <>
      <div className="panel"><h3>MODE STRATEGI — DEFAULT / SAFE / AGRESIF</h3>
        <div className="mono" style={{ fontSize: 11, color: '#8b98ad', marginBottom: 8 }}>Ganti preset butuh ENGINE STOPPED. Setiap aktivasi tercatat + trade menyimpan config hash-nya.</div>
        <div className="cols3">
          {(presets?.presets || []).map(p => (
            <div className="card" key={p.name} style={p.active ? { borderColor: '#22d3ee' } : undefined}>
              <h4 style={{ color: p.name === 'safe' ? '#4ade80' : p.name === 'agresif' ? '#f87171' : '#67e8f9' }}>{p.label} {p.active ? '● AKTIF' : ''}</h4>
              <div style={{ fontSize: 11, color: '#8b98ad', marginBottom: 6 }}>{p.desc}</div>
              <div className="mono" style={{ fontSize: 10.5 }}>
                threshold {p.params.entryScoreThreshold} · liq ${p.params.minLiquidityUsd.toLocaleString()} · vol ${p.params.minVolume24hUsd.toLocaleString()}<br />
                size {p.params.positionSizePct}% · max {p.params.maxPositions} pos · TP {p.params.tpPct}% / SL {p.params.slPct}%<br />
                daily-loss {p.params.dailyLossLimitPct}% · maxDD {p.params.maxDrawdownPct}%
              </div>
              <button className="btn" style={{ marginTop: 8, width: '100%' }} disabled={p.active} onClick={async () => {
                const r = await api('/config/preset', { method: 'POST', body: JSON.stringify({ preset: p.name }) });
                setPresetMsg(r.ok ? `${p.label} aktif (${r.hash})` : 'Gagal: ' + (r.reason || '?') + (r.hint ? ' — ' + r.hint : ''));
                reloadPresets();
              }}>{p.active ? 'AKTIF' : 'AKTIFKAN ' + p.label}</button>
            </div>
          ))}
        </div>
        {presetMsg && <div className="mono" style={{ fontSize: 11, color: '#facc15', marginTop: 6 }}>{presetMsg}</div>}
      </div>
      <div className="panel"><h3>STRATEGY & RULES — sofia-momentum-v1 · CFG {cfg?.hash}</h3>
        <pre className="mono" style={{ fontSize: 11, background: '#080d16', padding: 10, borderRadius: 4, overflowX: 'auto' }}>{JSON.stringify(cfg?.parameters, null, 1)}</pre>
        <div className="mono" style={{ fontSize: 11, color: '#8b98ad' }}>Every trade stores config_hash (§31). AI/LLM can never override hard security REJECT (§3).</div></div>
      <div className="panel"><h3>SECURITY CHECK SANDBOX (§15)</h3>
        <div className="cols3">
          <label className="mono">LIQ$ <input type="number" value={form.liquidityUsd} onChange={e => setForm({ ...form, liquidityUsd: +e.target.value })} /></label>
          <label className="mono">TOP10% <input type="number" value={form.top10Pct} onChange={e => setForm({ ...form, top10Pct: +e.target.value })} /></label>
          <label className="mono">DEV% <input type="number" value={form.devPct} onChange={e => setForm({ ...form, devPct: +e.target.value })} /></label>
        </div>
        <button className="btn" style={{ marginTop: 8 }} onClick={async () => setOut(await api('/security/check', { method: 'POST', body: JSON.stringify(form) }))}>RUN CHECK</button>
        {out && <pre className="mono" style={{ fontSize: 11 }}>{JSON.stringify(out, null, 1)}</pre>}
      </div>
    </>
  );
}

function ScanButton({ status, reload }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      <button className="btn go" disabled={status?.engine !== 'RUNNING' || busy} onClick={async () => {
        setBusy(true); setNote('');
        try {
          const r = await api('/scan', { method: 'POST' });
          setNote(r.ok ? `scan: ${r.scanned} token · ${r.entries} entry` : 'gagal: ' + (r.reason || 'error'));
        } catch (e) { setNote('feed offline — cek koneksi DexScreener/RPC'); }
        setBusy(false); reload();
      }}>{busy ? 'SCANNING…' : 'RUN SCAN TICK'}{status?.engine !== 'RUNNING' ? ' (ENGINE STOPPED)' : ''}</button>
      {note && <span className="mono" style={{ fontSize: 10.5, color: '#facc15' }}>{note}</span>}
    </span>
  );
}

function CoinFlow() {
  const [trades] = usePoll(() => api('/trades?limit=100'), 8000);
  const [fills] = usePoll(() => api('/fills'), 10000);
  const [live] = usePoll(() => api('/pnl/live'), 5000);
  const { rate, mode } = useFx();
  const liveById = Object.fromEntries((live?.positions || []).map(p => [p.id, p]));
  const open = (trades || []).filter(t => t.state === 'OPEN' || t.state === 'EMERGENCY_EXIT');
  const closed = (trades || []).filter(t => t.state === 'CLOSED').slice(0, 8);
  const coin = (s) => (
    <span className="mono" style={{ display: 'inline-block', minWidth: 64, textAlign: 'center', fontWeight: 800, fontSize: 11, background: '#131c2c', border: '1px solid #2b3d5f', borderRadius: 4, padding: '3px 8px', color: '#67e8f9' }}>{s || '?'}</span>
  );
  return (
    <div className="panel"><h3>ARUS KOIN — DIBELI / DIJUAL</h3>
      <div className="cols2">
        <div>
          <div className="mono" style={{ fontSize: 11, color: '#4ade80', fontWeight: 700, marginBottom: 6 }}>● DIBELI — SEDANG DIPEGANG ({open.length})</div>
          {open.length === 0 && <div className="mono" style={{ fontSize: 11, color: '#5b6b82' }}>belum ada posisi — start engine lalu scan</div>}
          {open.map(t => {
            const L = liveById[t.id];
            const up = (L ? L.unrealized : 0) >= 0;
            return (
              <div key={t.id} className="mono" style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 0', borderBottom: '1px solid #121a28', fontSize: 11.5 }}>
                {coin(t.symbol)}
                <span style={{ color: '#5b6b82' }}>{fmtUsd(t.entry_price)} → <b style={{ color: '#fff' }}>{L?.live ? fmtUsd(L.live_price) : '…'}</b></span>
                <span className={up ? 'up' : 'down'} style={{ fontWeight: 700 }}>{L ? <Money idr={L.unrealized} /> : '…'} <span style={{ fontSize: '0.85em' }}>{L ? `(${L.pnl_pct >= 0 ? '+' : ''}${L.pnl_pct}%)` : ''}</span></span>
                <span style={{ marginLeft: 'auto', color: '#8b98ad' }}>{L?.live ? 'LIVE' : 'quote…'} · {ago(t.entry_ts)}</span>
              </div>
            );
          })}
        </div>
        <div>
          <div className="mono" style={{ fontSize: 11, color: '#f87171', fontWeight: 700, marginBottom: 6 }}>● DIJUAL — BARU DITUTUP</div>
          {closed.length === 0 && <div className="mono" style={{ fontSize: 11, color: '#5b6b82' }}>belum ada penjualan</div>}
          {closed.map(t => (
            <div key={t.id} className="mono" style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 0', borderBottom: '1px solid #121a28', fontSize: 11.5 }}>
              {coin(t.symbol)}
              <span style={{ color: '#5b6b82' }}>{fmtUsd(t.entry_price)} → {fmtUsd(t.exit_price)}</span>
              <span style={{ fontWeight: 700 }}><Money idr={t.pnl_net} color={(t.pnl_net ?? 0) >= 0 ? '#4ade80' : '#f87171'} /></span>
              <span style={{ marginLeft: 'auto', color: '#8b98ad' }}>{t.exit_reason} · {ago(t.exit_ts)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="mono" style={{ fontSize: 11, color: '#8b98ad', marginTop: 8 }}>
        FILL TERAKHIR: {(fills || []).slice(0, 4).map(f => `${f.symbol || '?'} @ ${fmtUsd(f.price)} (fee ${mode === '$' ? fmtUSD(f.fee, rate) : 'Rp' + Math.round(f.fee ?? 0).toLocaleString('id-ID')} · slip ${f.slippage_bps}bps${f.simulated ? ' · sim' : ''})`).join('   |   ') || '—'}
      </div>
    </div>
  );
}

function RiskInline() {
  const [risk] = usePoll(() => api('/risk'), 8000);
  const { rate: riRate, mode: riMode } = useFx();
  const ri = (v) => riMode === '$' ? fmtUSD(v, riRate) : 'Rp' + Math.round(v ?? 0).toLocaleString('id-ID');
  if (!risk) return null;
  return <div className="mono" style={{ fontSize: 12 }}>Equity {ri(risk.equity)} · Daily {ri(risk.dailyPnl)} (lim {risk.dailyLossLimitPct}%) · DD {risk.drawdown}% · Open {risk.openPositions}/{risk.maxPositions} · Risk {ri(risk.capitalAtRisk)} · ConsecLoss {risk.consecutiveLosses} · <span className={`tag ${risk.status === 'NORMAL' ? 'normal' : 'warning'}`}>{risk.status}</span></div>;
}

function Risk({ reload }) {
  const [risk, refresh] = usePoll(() => api('/risk'), 5000);
  return (
    <div className="panel"><h3>RISK & LIMITS — MANDATORY GATE (§17)</h3>
      {risk && <div className="cols3">
        {[['Equity', <Money idr={risk.equity} />], ['Daily PnL', <Money idr={risk.dailyPnl} color={risk.dailyPnl >= 0 ? '#4ade80' : '#f87171'} />], ['Drawdown', risk.drawdown + '%'], ['Open', `${risk.openPositions}/${risk.maxPositions}`], ['Capital at Risk', <Money idr={risk.capitalAtRisk} />], ['Consec Losses', risk.consecutiveLosses]].map(([k, v]) => (
          <div className="card" key={k}><h4>{k.toUpperCase()}</h4><div className="v">{v}</div></div>))}
      </div>}
      <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
        <button className="btn danger" onClick={async () => { await api('/kill', { method: 'POST', body: '{}' }); refresh(); reload(); }}>KILL SWITCH — STOP ALL ENTRIES</button>
        <button className="btn" onClick={async () => { await api('/kill/release', { method: 'POST', body: '{}' }); refresh(); reload(); }}>RELEASE</button>
      </div>
    </div>
  );
}

function Wallet() {
  const [w] = usePoll(() => api('/wallet'), 8000);
  const [live] = usePoll(() => api('/pnl/live'), 5000);
  return (
    <div className="cols2">
      <div className="panel"><h3>PAPER WALLET — VIRTUAL CAPITAL</h3>
        {w && Object.entries(w.paper).map(([k, v]) => <div key={k} className="mono" style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}><span style={{ color: '#8b98ad' }}>{k}</span><b>{typeof v === 'number' ? <Money idr={v} /> : v}</b></div>)}
        <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderTop: '1px solid #1b2433', marginTop: 4 }}><span style={{ color: '#4ade80' }}>unrealized (live)</span><b><Money idr={live?.total_unrealized ?? 0} color={(live?.total_unrealized ?? 0) >= 0 ? '#4ade80' : '#f87171'} /></b></div>
      </div>
      <div className="panel"><h3>LIVE WALLET — REAL (KEY NEVER SHOWN)</h3>
        {w && <><div className="mono">addr: {w.live.address} · {w.live.connected ? 'CONNECTED' : 'DISCONNECTED'}</div>
          <div className="mono">SOL {w.live.sol} · USDC {w.live.usdc}</div>
          <button className="btn" style={{ marginTop: 8 }} onClick={() => api('/wallet/connect', { method: 'POST', body: JSON.stringify({ wallet: '7xKX…9p2m' }) })}>CONNECT (MOCK)</button></>}
      </div>
    </div>
  );
}

function Vault() {
  const [v, refresh] = usePoll(() => api('/vault'), 8000);
  const { rate } = useFx();
  return (
    <div className="panel"><h3>PROFIT VAULT — HWM SWEEP 50% (§28)</h3>
      {v && <div className="mono" style={{ fontSize: 12 }}>HWM <Money idr={v.hwm} /> · Equity <Money idr={v.equity} /> · Above <Money idr={v.profitAbove} /> · Eligible <Money idr={v.eligible} /> · Swept <Money idr={v.sweptTotal} /></div>}
      <button className="btn go" style={{ marginTop: 8 }} onClick={async () => { const r = await api('/vault/sweep', { method: 'POST', body: '{}' }); alert(r.ok ? `Swept ${fmtUSD(r.swept, rate)} (sim=${r.simulated})` : r.reason); refresh(); }}>SWEEP 50% ABOVE HWM</button>
      <table style={{ marginTop: 8 }}><thead><tr><th>TS</th><th>SWEPT</th><th>MODE</th><th>SIM</th><th>DEST</th></tr></thead><tbody>
        {(v?.sweeps || []).map(s => <tr key={s.id}><td>{new Date(s.ts).toLocaleString()}</td><td><CellMoney idr={s.swept} /></td><td>{s.mode}</td><td>{s.simulated ? 'yes' : 'no'}</td><td>{s.dest}</td></tr>)}
      </tbody></table>
    </div>
  );
}

function System({ reload }) {
  const [s] = usePoll(() => api('/system'), 5000);
  const [pf] = usePoll(() => api('/engine/preflight'), 8000);
  const [events, refreshEv] = usePoll(() => api('/engine/events'), 5000);
  return (
    <>
      <div className="panel"><h3>SYSTEM ENGINE — PREFLIGHT (10 CHECKS)</h3>
        <table><thead><tr><th>CHECK</th><th>PASS</th><th>DETAIL</th></tr></thead><tbody>
          {(pf?.checks || []).map(c => <tr key={c.name}><td>{c.name}</td><td className={c.pass ? 'up' : 'down'}>{c.pass ? 'PASS' : 'FAIL'}{c.critical ? ' (critical)' : ''}</td><td>{c.detail || ''}</td></tr>)}
        </tbody></table></div>
      <div className="panel"><h3>LAST DECISION / ORDER / FILL / ERROR</h3>
        <pre className="mono" style={{ fontSize: 10.5, maxHeight: 220, overflow: 'auto' }}>{JSON.stringify({ lastDecision: s?.lastDecision, lastOrder: s?.lastOrder, lastFill: s?.lastFill, lastError: s?.lastError, config: s?.config?.hash }, null, 1)}</pre></div>
      <div className="panel"><h3>EVENT LOG — START/STOP/PAUSE/EMERGENCY/MODE/CONFIG/ORDER/FILL</h3>
        <table><thead><tr><th>TS</th><th>EVENT</th><th>DETAIL</th></tr></thead><tbody>
          {(events || []).slice(0, 30).map(e => <tr key={e.id}><td>{new Date(e.ts).toLocaleTimeString()}</td><td>{e.event}</td><td>{e.detail}</td></tr>)}
        </tbody></table></div>
    </>
  );
}

function Settings() {
  return <div className="panel"><h3>SETTINGS</h3><div className="mono" style={{ fontSize: 12, color: '#8b98ad' }}>Backend :8787 · Frontend :5173 · SQLite data/sofia.db (append-only audit) · RPC Helius-compatible · Execution Jupiter Lite API.<br />Paper adapter: real quote + simulated fill · Live adapter: guarded, requires activation + wallet.<br />Secrets stay server-side; private key never rendered.</div></div>;
}

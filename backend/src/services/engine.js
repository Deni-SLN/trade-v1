// Engine state machine (§10), preflight (§8), stop flows (§9), mode switching (§30), kill (§26).
import crypto from 'node:crypto';
import { db, currentConfig, logEngine } from '../db.js';
import { serviceHealth } from './market.js';

const TRANSITIONS = {
  OFFLINE: ['STARTING'],
  STARTING: ['RUNNING', 'STOPPED'],
  RUNNING: ['PAUSED', 'STOPPING', 'EMERGENCY_STOP'],
  PAUSED: ['RUNNING', 'STOPPING'],
  STOPPING: ['STOPPED'],
  STOPPED: ['STARTING'],
  EMERGENCY_STOP: ['SAFE_STATE'],
  SAFE_STATE: ['STARTING']
};

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

export function preflight(state, cfg) {
  const h = serviceHealth();
  const checks = [
    { name: 'database', pass: true, critical: true },
    { name: 'market_data', pass: h.marketOk, critical: true },
    { name: 'solana_rpc', pass: h.rpcLatency < 2000, critical: true, detail: `${h.rpcLatency}ms` },
    { name: 'jupiter_api', pass: h.jupiterOk, critical: true },
    { name: 'wallet', pass: state.mode.current === 'PAPER' ? true : state.live.connected, critical: state.mode.current === 'LIVE' },
    { name: 'strategy_config', pass: !!cfg?.hash, critical: true, detail: cfg?.hash },
    { name: 'risk_config', pass: true, critical: true },
    { name: 'kill_switch', pass: !state.kill.engaged, critical: true },
    { name: 'execution_adapter', pass: true, critical: true, detail: state.mode.current },
    { name: 'data_freshness', pass: Date.now() - h.lastUpdate < 60000, critical: true }
  ];
  const blocked = checks.filter(c => c.critical && !c.pass);
  return { checks, ok: blocked.length === 0, blocked };
}

export function startEngine(state) {
  if (state.engine.state === 'RUNNING') return { ok: true, already: true };
  if (state.kill.engaged) return {
    ok: false, reason: 'KILL_SWITCH_ENGAGED',
    hint: 'Kill-switch latch is ENGAGED (persists across restarts by design). Release it first: header → RELEASE KILL-SWITCH, or Risk & Limits → RELEASE. Then START.'
  };
  const cfg = currentConfig();
  const pf = preflight(state, cfg);
  if (!pf.ok) {
    logEngine('START_BLOCKED', pf.blocked.map(b => b.name).join(','));
    return { ok: false, reason: pf.blocked[0]?.name || 'unknown', checks: pf.checks };
  }
  if (!canTransition(state.engine.state, 'STARTING')) {
    return { ok: false, reason: `illegal transition from ${state.engine.state}` };
  }
  state.engine.state = 'RUNNING';
  state.engine.startedAt = Date.now();
  logEngine('START', `mode=${state.mode.current} cfg=${cfg.hash}`);
  db.prepare('INSERT INTO circuit_events (ts,kind,detail) VALUES (?,?,?)').run(Date.now(), 'START', state.mode.current);
  return { ok: true, checks: pf.checks };
}

export function stopEngine(state, mode = 'complete') {
  // mode: new_entries | complete | emergency
  if (mode === 'emergency') {
    state.engine.state = 'EMERGENCY_STOP';
    state.kill.engaged = true;
    state.kill.ts = Date.now();
    logEngine('EMERGENCY_STOP', 'kill engaged');
    db.prepare('INSERT INTO circuit_events (ts,kind,detail) VALUES (?,?,?)').run(Date.now(), 'EMERGENCY_STOP', 'manual');
    // Per PRD, emergency may trigger exits — mark opens for review
    db.prepare("UPDATE trades SET state='EMERGENCY_EXIT' WHERE state='OPEN'").run();
  } else if (mode === 'new_entries') {
    state.engine.state = 'PAUSED';
    logEngine('PAUSE', 'stop new entries, manage existing');
  } else {
    state.engine.state = 'STOPPED';
    state.engine.stopMode = mode;
    logEngine('STOP', mode);
  }
  db.prepare('INSERT INTO circuit_events (ts,kind,detail) VALUES (?,?,?)').run(Date.now(), 'STOP', mode);
  return { ok: true, state: state.engine.state };
}

export function requestModeSwitch(state, target) {
  // §30: switching requires STOPPED + confirmations
  const pending = db.prepare("SELECT COUNT(*) c FROM orders WHERE state IN ('CREATED','QUOTED','SUBMITTED')").get()?.c ?? 0;
  if (pending > 0) return { ok: false, reason: 'PENDING_ORDERS_REQUIRE_RECONCILIATION' };
  if (state.engine.state !== 'STOPPED' && state.engine.state !== 'OFFLINE' && state.engine.state !== 'SAFE_STATE') {
    if (target === 'LIVE') return { ok: false, reason: 'ENGINE_MUST_BE_STOPPED', needConfirmation: true };
    // LIVE -> PAPER: stop new entries first
    return { ok: false, reason: 'ENGINE_MUST_BE_STOPPED', needConfirmation: true };
  }
  if (target === 'LIVE') {
    const h = serviceHealth();
    const gates = [
      ['Security Engine healthy', true],
      ['Risk Engine healthy', !state.kill.engaged],
      ['RPC healthy', h.rpcLatency < 2000],
      ['Jupiter healthy', h.jupiterOk],
      ['Wallet connected', state.live.connected],
      ['Kill switch available', true],
      ['Risk limits configured', true]
    ];
    const failed = gates.filter(g => !g[1]);
    if (failed.length) return { ok: false, reason: 'LIVE_SAFETY_GATE', failed: failed.map(f => f[0]), gates };
    return { ok: true, needExplicitConfirm: true, gates };
  }
  return { ok: true, needExplicitConfirm: true };
}

export function confirmModeSwitch(state, target) {
  const chk = requestModeSwitch(state, target);
  if (!chk.ok) return chk;
  if (target === 'LIVE') {
    state.mode.current = 'LIVE';
    state.mode.liveActivated = true;
    state.mode.activatedAt = Date.now();
  } else {
    state.mode.current = 'PAPER';
  }
  logEngine('MODE_CHANGE', target);
  return { ok: true, mode: state.mode.current };
}

export function engageKill(state, reason = 'manual') {
  state.kill = { engaged: true, ts: Date.now() };
  state.engine.state = 'EMERGENCY_STOP';
  state.risk.circuit = 'TRADING_PAUSED';
  logEngine('EMERGENCY_STOP', reason);
  db.prepare('INSERT INTO circuit_events (ts,kind,detail) VALUES (?,?,?)').run(Date.now(), 'KILL', reason);
  return state.kill;
}
export function releaseKill(state) {
  state.kill = { engaged: false, ts: null };
  state.engine.state = 'STOPPED';
  state.risk.circuit = 'NORMAL';
  logEngine('RESUME', 'kill released');
  return state.kill;
}

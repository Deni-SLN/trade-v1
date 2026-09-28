import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const dataDir = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'sofia.db');

export const db = new DatabaseSync(dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS config_versions (
  config_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  parameters TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  mint TEXT NOT NULL,
  price REAL, liquidity REAL, volume24h REAL,
  buys INTEGER, sells INTEGER, holders INTEGER,
  raw TEXT
);
CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  mint TEXT NOT NULL, symbol TEXT,
  mode TEXT NOT NULL,
  strategy_version TEXT, config_hash TEXT,
  security_verdict TEXT, security_score REAL,
  strategy_verdict TEXT, strategy_score REAL,
  risk_verdict TEXT, risk_reason TEXT,
  entry_price REAL, exit_price REAL,
  pnl REAL, fees REAL, slippage_bps REAL, latency_ms REAL,
  exit_reason TEXT, status TEXT DEFAULT 'LOGGED'
);
CREATE TABLE IF NOT EXISTS orders (
  intent_id TEXT PRIMARY KEY,
  decision_id TEXT,
  ts INTEGER NOT NULL,
  mint TEXT NOT NULL, side TEXT NOT NULL,
  qty REAL, quoted_price REAL,
  mode TEXT NOT NULL, state TEXT NOT NULL,
  tx_sig TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  price REAL NOT NULL, qty REAL NOT NULL,
  fee REAL DEFAULT 0, slippage_bps REAL DEFAULT 0,
  simulated INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  mint TEXT NOT NULL, symbol TEXT,
  mode TEXT NOT NULL,
  entry_ts INTEGER, exit_ts INTEGER,
  entry_price REAL, exit_price REAL, qty REAL,
  pnl_gross REAL, pnl_net REAL, fees REAL, slippage_bps REAL,
  mae REAL, mfe REAL, hold_secs INTEGER,
  exit_reason TEXT, config_hash TEXT,
  state TEXT DEFAULT 'OPEN'
);
CREATE TABLE IF NOT EXISTS shadow_outcomes (
  mint TEXT PRIMARY KEY,
  symbol TEXT, rejected_ts INTEGER,
  reject_reason TEXT,
  p15 REAL, p60 REAL, p1440 REAL,
  max_upside REAL, max_downside REAL,
  verdict TEXT DEFAULT 'TRACKING'
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, mode TEXT NOT NULL,
  kind TEXT NOT NULL, amount REAL NOT NULL, note TEXT
);
CREATE TABLE IF NOT EXISTS sweeps (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL,
  hwm_before REAL, equity REAL, profit_above REAL,
  swept REAL, retained REAL, mode TEXT NOT NULL,
  dest TEXT, simulated INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS circuit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT
);
CREATE TABLE IF NOT EXISTS eval_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, window_trades INTEGER,
  win_rate REAL, expectancy REAL, profit_factor REAL, avg_r REAL
);
CREATE TABLE IF NOT EXISTS engine_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, event TEXT NOT NULL, detail TEXT
);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY, v TEXT NOT NULL
);
`);

function kvGet(k, fallback) {
  const r = db.prepare('SELECT v FROM kv WHERE k=?').get(k);
  return r ? JSON.parse(r.v) : fallback;
}
function kvSet(k, v) {
  db.prepare('INSERT OR REPLACE INTO kv (k,v) VALUES (?,?)').run(k, JSON.stringify(v));
}

export { kvGet, kvSet };

// ---- default config version (§31) ----
const DEFAULT_PARAMS = {
  strategy: 'sofia-momentum-v1',
  minLiquidityUsd: 20000,
  minVolume24hUsd: 50000,
  minHolders: 300,
  maxTop10Pct: 35,
  maxPriceImpactBps: 300,
  entryScoreThreshold: 62,
  tpPct: 25, slPct: -12,
  trailPct: 10, maxHoldMins: 180,
  positionSizePct: 5, maxPositions: 4,
  dailyLossLimitPct: 6, maxDrawdownPct: 15,
  cooldownSecs: 120, slippageLimitBps: 500
};
const hash = crypto.createHash('sha256').update(JSON.stringify(DEFAULT_PARAMS)).digest('hex').slice(0, 16);
const existing = db.prepare('SELECT * FROM config_versions ORDER BY created_at DESC LIMIT 1').get();
if (!existing) {
  db.prepare('INSERT INTO config_versions (config_id,version,created_at,parameters,hash) VALUES (?,?,?,?,?)')
    .run(crypto.randomUUID(), 'v1.0.0', Date.now(), JSON.stringify(DEFAULT_PARAMS), hash);
}
export function currentConfig() {
  const row = db.prepare('SELECT * FROM config_versions ORDER BY created_at DESC LIMIT 1').get();
  return { ...row, parameters: JSON.parse(row.parameters) };
}
export function getDefaultState() {
  return {
    engine: kvGet('engine', { state: 'STOPPED', stopMode: null }),
    mode: kvGet('mode', { current: 'PAPER', liveActivated: false }),
    kill: kvGet('kill', { engaged: false, ts: null }),
    paper: kvGet('paper', { initialCapital: 500000, equity: 643200, cash: 420000 }),
    risk: kvGet('risk', { dailyPnl: -8200, consecutiveLosses: 1, circuit: 'NORMAL' }),
    live: kvGet('live', { wallet: '7xKX…9p2m', sol: 3.42, usdc: 812.5, connected: false })
  };
}
export function persistState(s) {
  kvSet('engine', s.engine); kvSet('mode', s.mode);
  kvSet('kill', s.kill); kvSet('paper', s.paper);
  kvSet('risk', s.risk); kvSet('live', s.live);
}
export function logEngine(event, detail = '') {
  db.prepare('INSERT INTO engine_events (ts,event,detail) VALUES (?,?,?)').run(Date.now(), event, detail);
}

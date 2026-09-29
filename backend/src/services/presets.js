// Strategy/risk presets: DEFAULT / SAFE / AGRESIF (§16-17 tunables).
// Activation inserts a new config_version (audited, hashed); trades keep
// carrying their own config_hash so performance stays attributable.
import crypto from 'node:crypto';
import { db, logEngine } from '../db.js';

export const PRESETS = {
  default: {
    label: 'DEFAULT', desc: 'Seimbang — filter standar meme Solana.',
    params: {
      strategy: 'sofia-momentum-v1',
      minLiquidityUsd: 20000, minVolume24hUsd: 50000, minHolders: 300,
      maxTop10Pct: 35, maxPriceImpactBps: 300, entryScoreThreshold: 62,
      tpPct: 25, slPct: -12, trailPct: 10, maxHoldMins: 180,
      positionSizePct: 5, maxPositions: 4,
      dailyLossLimitPct: 6, maxDrawdownPct: 15,
      cooldownSecs: 120, slippageLimitBps: 500
    }
  },
  safe: {
    label: 'SAFE', desc: 'Konservatif — hanya setup paling bersih, size kecil.',
    params: {
      strategy: 'sofia-momentum-v1-safe',
      minLiquidityUsd: 50000, minVolume24hUsd: 150000, minHolders: 500,
      maxTop10Pct: 30, maxPriceImpactBps: 200, entryScoreThreshold: 70,
      tpPct: 18, slPct: -8, trailPct: 8, maxHoldMins: 120,
      positionSizePct: 3, maxPositions: 2,
      dailyLossLimitPct: 4, maxDrawdownPct: 10,
      cooldownSecs: 300, slippageLimitBps: 300
    }
  },
  agresif: {
    label: 'AGRESIF', desc: 'Agresif — entry longgar, size besar, risiko tinggi.',
    params: {
      strategy: 'sofia-momentum-v1-agresif',
      minLiquidityUsd: 10000, minVolume24hUsd: 25000, minHolders: 150,
      maxTop10Pct: 45, maxPriceImpactBps: 500, entryScoreThreshold: 55,
      tpPct: 35, slPct: -18, trailPct: 12, maxHoldMins: 300,
      positionSizePct: 8, maxPositions: 6,
      dailyLossLimitPct: 10, maxDrawdownPct: 25,
      cooldownSecs: 60, slippageLimitBps: 800
    }
  }
};

export function activatePreset(name, state) {
  const p = PRESETS[name];
  if (!p) return { ok: false, reason: 'UNKNOWN_PRESET' };
  if (state && state.engine.state !== 'STOPPED' && state.engine.state !== 'OFFLINE') {
    return { ok: false, reason: 'ENGINE_MUST_BE_STOPPED', hint: 'Stop engine dulu sebelum ganti preset.' };
  }
  const hash = crypto.createHash('sha256').update(JSON.stringify(p.params)).digest('hex').slice(0, 16);
  const row = db.prepare('SELECT * FROM config_versions WHERE hash=?').get(hash);
  if (!row) {
    db.prepare('INSERT INTO config_versions (config_id,version,created_at,parameters,hash) VALUES (?,?,?,?,?)')
      .run(crypto.randomUUID(), 'v1.0.0-' + name, Date.now(), JSON.stringify(p.params), hash);
  } else {
    // re-activate existing: touch by inserting new version row pointing to same params
    db.prepare('INSERT INTO config_versions (config_id,version,created_at,parameters,hash) VALUES (?,?,?,?,?)')
      .run(crypto.randomUUID(), 'v1.0.0-' + name, Date.now(), JSON.stringify(p.params), hash);
  }
  logEngine('CONFIG_CHANGE', `preset=${name} hash=${hash}`);
  return { ok: true, preset: name, hash };
}

export function listPresets(currentHash) {
  return Object.entries(PRESETS).map(([name, p]) => {
    const hash = crypto.createHash('sha256').update(JSON.stringify(p.params)).digest('hex').slice(0, 16);
    return { name, label: p.label, desc: p.desc, hash, active: hash === currentHash, params: p.params };
  });
}

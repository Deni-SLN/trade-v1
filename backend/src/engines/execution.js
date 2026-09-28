// §19 ExecutionPort: get_quote / submit / get_balances / reconcile
// Strategy never knows Paper vs Live — only adapter differs (§44).
import crypto from 'node:crypto';
import { db } from '../db.js';
import { getJupiterQuote } from '../services/market.js';

export class PaperAdapter {
  name = 'PAPER';
  async get_quote({ inputMint, outputMint, amount }) {
    return getJupiterQuote({ inputMint, outputMint, amount });
  }
  async submit({ decisionId, mint, side, qty, quotedPrice }) {
    const intentId = crypto.randomUUID();
    const latency = 180 + Math.round(Math.random() * 320);
    const slipBps = 20 + Math.round(Math.random() * 80);
    const fee = Math.max(1, Math.round(qty * quotedPrice * 0.0005));
    const fillPrice = quotedPrice * (side === 'BUY' ? (1 + slipBps / 10000) : (1 - slipBps / 10000));
    const ts = Date.now();
    db.prepare(`INSERT INTO orders (intent_id,decision_id,ts,mint,side,qty,quoted_price,mode,state) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(intentId, decisionId, ts, mint, side, qty, quotedPrice, 'PAPER', 'CONFIRMED');
    db.prepare(`INSERT INTO fills (intent_id,ts,price,qty,fee,slippage_bps,simulated) VALUES (?,?,?,?,?,?,1)`)
      .run(intentId, ts + latency, fillPrice, qty, fee, slipBps);
    return { intentId, state: 'CONFIRMED', fillPrice, fee, slippageBps: slipBps, latencyMs: latency, simulated: true, txSig: null };
  }
  async get_balances(state) { return { equity: state.paper.equity, cash: state.paper.cash, simulated: true }; }
  async reconcile(intentId) {
    return db.prepare('SELECT * FROM orders WHERE intent_id=?').get(intentId);
  }
}

export class LiveAdapter {
  name = 'LIVE';
  async get_quote(args) { return getJupiterQuote(args); }
  async submit() {
    // Live broadcast happens ONLY via explicit activation + running engine.
    // Full tx signing (Helius + wallet) is wired in Phase 7; V1 keeps a guarded stub
    // that refuses to broadcast unless activation record exists — safety by default.
    const err = new Error('LIVE broadcast disabled in V1 scaffold: connect wallet + enable activation first');
    err.code = 'LIVE_NOT_ACTIVATED';
    throw err;
  }
  async get_balances(state) { return { sol: state.live.sol, usdc: state.live.usdc, simulated: false }; }
  async reconcile(intentId) {
    return db.prepare('SELECT * FROM orders WHERE intent_id=?').get(intentId);
  }
}

export function adapterFor(mode) {
  return mode === 'LIVE' ? new LiveAdapter() : new PaperAdapter();
}

# SOFIA MEME BOT V1.0 — Solana Meme Quant Terminal

Dark quant terminal: real market data (DexScreener profiles + boosts, Solana RPC
on-chain, Jupiter quotes), Security → Strategy → Risk pipeline, Paper/Live
execution adapters, audit log. No synthetic prices — feeds that fail surface
as errors, never fake data.

## Run

```powershell
# terminal 1 — backend :8787 (serves API + built frontend)
cd backend; npm install; npm start

# terminal 2 — frontend dev :5173 (optional, hot reload)
cd frontend; npm install; npm run dev
```

Open http://localhost:8787 (prod) or http://localhost:5173 (dev).

## Flow

1. Header shows MODE (PAPER/LIVE) + ENGINE state + SOL/Jupiter/RPC status.
2. `START ENGINE` runs 10-point preflight; blocked if any critical check fails.
3. `RUN SCAN TICK` (Overview) or auto-tick every 30s: discovery → security
   (PASS/REJECT/UNKNOWN) → strategy (ENTRY/WAIT/REJECT) → risk gate → paper fill.
4. `LIVE TRADE` opens safety-gate panel; requires engine STOPPED + wallet
   connect + healthy services + explicit confirm. Live broadcast is guarded
   in V1 (no key handling) — paper is the fully working loop.
5. `KILL ⏻` halts entries everywhere (header / Risk / System).

## Notes

- Public Solana RPC is heavily rate-limited (429). Set `SOLANA_RPC_URL` to a
  Helius (or compatible) endpoint before `npm start` for full on-chain
  enrichment (authorities, holder concentration). Without it, unknown fields
  stay UNKNOWN — entries then only happen via PAPER-only conditional path.
- GMGN rank API blocks server-side fetch (Cloudflare 403); discovery currently
  uses DexScreener. A GMGN lane needs a browser context or API key (Phase 2+).
- LIVE mode requires strict security PASS. PAPER allows conditional entries
  (half size, flagged) when zero rejects + critical bar passed.

## Layout

- `backend/src/engines/` — security, strategy, risk, execution (Paper/Live adapters)
- `backend/src/services/` — market (Jupiter/DexScreener), engine state machine, ledger/vault/shadow
- `backend/data/sofia.db` — SQLite, append-only audit tables (§34)
- `frontend/src/` — 12-module terminal (Overview → Settings)

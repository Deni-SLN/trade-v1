import express from 'express';
import cors from 'cors';
import path from 'node:path';
import api from './routes/api.js';
import { refreshMarketCache } from './services/market.js';
import { runScanCycle, computeKpis } from './services/ledger.js';
import { getState, save } from './routes/api.js';
import { logEngine } from './db.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use('/api', api);
app.get('/health', (req, res) => res.json({ ok: true, app: 'sofia-meme-bot', v: '1.0.0' }));

// static frontend (production single-origin)
const pub = path.resolve(process.cwd(), '../frontend/dist');
app.use(express.static(pub));
app.get(/^\/(?!api).*/, (req, res, next) => {
  res.sendFile(path.join(pub, 'index.html'), (err) => err ? next() : null);
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`[SOFIA] backend on :${PORT}`);
  logEngine('BOOT', `port=${PORT}`);
});

// background loops: market refresh 15s, scan tick 30s when RUNNING
setInterval(async () => { try { await refreshMarketCache(); } catch {} }, 15000);
refreshMarketCache().catch(() => {});
setInterval(async () => {
  try {
    const S = getState();
    if (S.engine.state === 'RUNNING' && !S.kill.engaged) {
      await runScanCycle(S); save();
    }
  } catch (e) { console.error('[scan]', e.message); }
}, 30000);

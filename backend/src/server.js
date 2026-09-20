import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { searchProducts, getCatalogProduct, getCatalog, catalogStatus, listTracked, getTracked, trackProduct, saveObservation, addLog, getHistory, getLogs } from './store.js';
import { scrapeProduct } from './scraper.js';

const app = express(); app.use(cors()); app.use(express.json());
const port = Number(process.env.PORT || 4000);

app.get('/api/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/api/products/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();

    console.log(`[SEARCH] "${q}"`);

    if (!q) {
      return res.json([]);
    }

    const results = await searchProducts(q);
    res.set('X-Catalog-Complete', String(catalogStatus().complete));

    console.log(`[SEARCH] Found ${results.length} results`);

    res.json(results);
  } catch (e) {
    console.error('[SEARCH ERROR]', e);
    res.status(500).json({
      error: e.message
    });
  }
});
app.get('/api/tracked-products', async (_,res)=>{try{res.json(await listTracked())}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/tracked-products', async (req, res) => {
  try {
    if (!req.body?.id) return res.status(400).json({ error: 'id is required' });
    // Resolve canonical identity from INE by ID. Never trust name/url/sku sent by the client.
    const canonical = await getCatalogProduct(req.body.id);
    if (!canonical) return res.status(404).json({ error: `Product ${req.body.id} not found in INE catalog` });
    res.status(201).json(await trackProduct(canonical));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/catalog/status', async (_, res) => { try { await getCatalog(); res.json(catalogStatus()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/catalog/refresh', async (_, res) => { try { await getCatalog({ force: true }); res.json(catalogStatus()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/tracked-products/:id/history', async(req,res)=>{try{res.json(await getHistory(req.params.id, Number(req.query.limit||100)))}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/tracked-products/:id/logs', async(req,res)=>{try{res.json(await getLogs(req.params.id, Number(req.query.limit||100)))}catch(e){res.status(500).json({error:e.message})}});

async function runOne(product, headed=false) {
  const started = Date.now(); const attempted_at = new Date().toISOString();
  try {
    const result = await scrapeProduct(product,{headed});
    await saveObservation(product.id,{price:result.price,stock:result.stock,scraped_at:attempted_at});
    await addLog(product.id,{status:result.attempts>1?'RETRIED':'SUCCESS',attempted_at,duration_ms:Date.now()-started,attempts:result.attempts,error_message:null});
    return { id: product.id, status:'success', ...result };
  } catch(e) {
    await addLog(product.id,{status:'FAILED',attempted_at,duration_ms:Date.now()-started,attempts:Number(process.env.SCRAPE_RETRIES||3),error_message:e.message});
    return { id: product.id, status:'failed', error:e.message };
  }
}

// ---------------------------------------------------------
// SCRAPE ALL TRACKED PRODUCTS — single-flight (no overlapping runs)
// Used by: manual "Refresh all", cron-job.org, optional internal timer.
// ---------------------------------------------------------
const STALE_MS = 45 * 60 * 1000; // safety: a hung run can't block forever
const scrape = { running: false, trigger: null, startedAt: null, finishedAt: null, total: 0, done: 0, ok: 0, failed: 0, last: null };

async function runAllTracked(trigger, headed = false) {
  if (scrape.running && Date.now() - Date.parse(scrape.startedAt) < STALE_MS) {
    return { started: false, reason: 'already_running' };
  }
  Object.assign(scrape, { running: true, trigger, startedAt: new Date().toISOString(), finishedAt: null, total: 0, done: 0, ok: 0, failed: 0 });
  const results = [];
  try {
    const products = await listTracked();
    scrape.total = products.length;
    console.log(`[RUN-ALL] (${trigger}) scraping ${products.length} tracked products`);
    for (const p of products) {
      const r = await runOne(p, headed); // sequential: the store rate-limits
      results.push(r);
      scrape.done++;
      r.status === 'success' ? scrape.ok++ : scrape.failed++;
    }
    return { started: true, results };
  } finally {
    scrape.running = false;
    scrape.finishedAt = new Date().toISOString();
    scrape.last = { trigger, started_at: scrape.startedAt, finished_at: scrape.finishedAt, total: scrape.total, ok: scrape.ok, failed: scrape.failed };
    console.log(`[RUN-ALL] (${trigger}) done: ${scrape.ok} ok, ${scrape.failed} failed`);
  }
}

// Manual "Refresh all" from the UI: waits for results (same as before), but can't overlap a cron run.
app.post('/api/scraper/run', async (req, res) => {
  try {
    const headed = req.query.headed === 'true' || process.env.HEADED === 'true';
    const out = await runAllTracked('manual', headed);
    if (!out.started) return res.status(409).json({ error: 'A scrape run is already in progress. Try again in a minute.' });
    res.json({ started_at: scrape.startedAt, results: out.results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Scheduled trigger (cron-job.org). Returns immediately; scrape continues in the background.
const secretOk = (req) => {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const given = String(req.get('x-cron-secret') || (req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
app.post('/api/cron/scrape', (req, res) => {
  if (!process.env.CRON_SECRET) return res.status(503).json({ error: 'CRON_SECRET is not configured on the server' });
  if (!secretOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (scrape.running && Date.now() - Date.parse(scrape.startedAt) < STALE_MS) {
    return res.status(200).json({ accepted: false, reason: 'already_running', started_at: scrape.startedAt });
  }
  runAllTracked('cron').catch((e) => console.error('[RUN-ALL] cron run crashed:', e));
  res.status(202).json({ accepted: true, message: 'Scrape started in background' });
});

// Public, read-only: is a run active, and how did the last one go?
app.get('/api/scraper/status', (_, res) => res.json(scrape));

// Optional in-process timer for hosts that never sleep (VPS / local). Overlap-safe via the same lock.
if (process.env.ENABLE_INTERNAL_SCHEDULER === 'true') {
  const every = Number(process.env.SCRAPE_INTERVAL_MINUTES || 120) * 60 * 1000;
  setInterval(() => runAllTracked('internal').catch((e) => console.error('[RUN-ALL] internal run crashed:', e)), every);
  console.log(`[SCHEDULER] internal timer every ${every / 60000} min`);
}

app.post('/api/scraper/run/:id', async(req,res)=>{try{const p=await getTracked(req.params.id);if(!p)return res.status(404).json({error:'Product not found'});res.json(await runOne(p,req.query.headed==='true'));}catch(e){res.status(500).json({error:e.message})}});

app.listen(port,()=>console.log(`INE Price Tracker API listening on http://localhost:${port}`));
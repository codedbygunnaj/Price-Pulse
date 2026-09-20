import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

// ---------------------------------------------------------
// Catalog = source of truth for product identity.
// Site's own frontend calls exactly:
//   GET /api/catalog?page=N&pageSize=20   -> { items, page, pages, total }
//   GET /api/product/:id                  -> single product (id,name,brand,sku,category,...)
// The store randomly answers 404/429/503, so every call is retried,
// first from Node, then from inside a real browser page (same-origin,
// real cookies) as a fallback.
// ---------------------------------------------------------

export const STORE_URL = (process.env.STORE_URL || 'https://demo.inelabteamdev.com').replace(/\/+$/, '');
const PAGE_SIZE = 20;
const CACHE_MS = Number(process.env.CATALOG_CACHE_MS || 30 * 60 * 1000);
const CACHE_FILE = path.resolve(process.env.CATALOG_CACHE_FILE || '.catalog-cache.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- transport 1: plain Node fetch with cookie jar ----------
const jar = new Map();
async function nodeGet(url) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-IN,en;q=0.9',
    Referer: `${STORE_URL}/`,
    'User-Agent': UA,
  };
  if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  for (const c of res.headers.getSetCookie?.() || []) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
  return { status: res.status, json: res.ok ? await res.json() : null };
}

// ---------- transport 2: real browser page, same-origin fetch ----------
let browser = null, page = null;
async function browserGet(url) {
  if (!page || page.isClosed()) {
    browser ||= await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ userAgent: UA });
    page = await ctx.newPage();
    await page.goto(`${STORE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 25000 });
  }
  return page.evaluate(async (u) => {
    const r = await fetch(u, { headers: { Accept: 'application/json' } });
    return { status: r.status, json: r.ok ? await r.json() : null };
  }, url);
}
export async function closeCatalogBrowser() {
  await browser?.close().catch(() => {});
  browser = page = null;
}

// Retry on 404/429/5xx/network errors. Node first, browser as fallback.
async function getJson(pathAndQuery, validate) {
  const url = `${STORE_URL}${pathAndQuery}`;
  let last = 'unknown';
  for (const [label, get] of [['node', nodeGet], ['browser', browserGet]]) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const { status, json } = await get(url);
        if (json && validate(json)) return json;
        last = `${label} ${status}${json ? ' (bad shape)' : ''}`;
      } catch (e) {
        last = `${label} ${e.message}`;
      }
      await sleep(attempt * 700 + Math.random() * 400);
    }
    console.warn(`[CATALOG] ${pathAndQuery}: ${label} transport exhausted (${last})`);
  }
  throw new Error(`GET ${pathAndQuery} failed: ${last}`);
}

// ---------- normalisation: URL is ALWAYS built from the id ----------
export const productUrl = (id) => `${STORE_URL}/product/${id}`;
function normalize(p) {
  const id = String(p.id);
  return {
    id,
    name: p.name || p.title || `Product ${id}`,
    url: productUrl(id), // never trust item.url
    category: p.category || null,
    brand: p.brand || null,
    sku: p.sku || null,
  };
}

// ---------- full catalog ----------
let cache = null; // { products, total, pages, complete, at }
let inflight = null;

async function readDiskCache() {
  try {
    const c = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'));
    if (c.complete && Date.now() - c.at < CACHE_MS) return c;
  } catch {}
  return null;
}

async function loadCatalog() {
  const fetchPage = (n) =>
    getJson(`/api/catalog?page=${n}&pageSize=${PAGE_SIZE}`, (j) => Array.isArray(j?.items));

  const first = await fetchPage(1);
  const pages = Number(first.pages) || Math.ceil(Number(first.total) / PAGE_SIZE) || 1;
  const total = Number(first.total) || first.items.length;
  console.log(`[CATALOG] INE reports total=${total}, pages=${pages}`);

  const byId = new Map();
  const add = (items) => items.forEach((p) => p?.id != null && byId.set(String(p.id), normalize(p)));
  add(first.items);

  // sequential + small gap: the demo store 503s under load
  let missing = [];
  for (let n = 2; n <= pages; n++) {
    try { add((await fetchPage(n)).items); }
    catch (e) { console.warn(`[CATALOG] page ${n} failed: ${e.message}`); missing.push(n); }
    await sleep(150);
  }
  // second pass for pages that failed
  for (const n of [...missing]) {
    try { add((await fetchPage(n)).items); missing = missing.filter((x) => x !== n); }
    catch {}
  }

  const complete = missing.length === 0 && byId.size >= total;
  console.log(`[CATALOG] ${byId.size}/${total} unique products, missing pages: [${missing}] complete=${complete}`);
  const result = { products: [...byId.values()], total, pages, complete, missingPages: missing, at: Date.now() };
  if (complete) fs.writeFile(CACHE_FILE, JSON.stringify(result)).catch(() => {});
  return result;
}

export async function getCatalog({ force = false } = {}) {
  if (!force && cache && (cache.complete ? Date.now() - cache.at < CACHE_MS : Date.now() - cache.at < 20000)) return cache;
  if (!force) {
    const disk = await readDiskCache();
    if (disk) return (cache = disk);
  }
  inflight ||= loadCatalog().then((c) => (cache = c)).finally(() => { inflight = null; });
  return inflight; // concurrent searches share ONE load
}

export function catalogStatus() {
  return cache
    ? { loaded: cache.products.length, total: cache.total, pages: cache.pages, complete: cache.complete, missingPages: cache.missingPages || [], at: new Date(cache.at).toISOString() }
    : { loaded: 0, complete: false };
}

// ---------- exact product by id (canonical identity) ----------
export async function getCatalogProduct(id) {
  id = String(id);
  try {
    const p = await getJson(`/api/product/${encodeURIComponent(id)}`, (j) => j && j.id != null);
    if (String(p.id) === id) return normalize(p);
  } catch (e) {
    console.warn(`[CATALOG] /api/product/${id} failed: ${e.message}`);
  }
  const c = cache || (await getCatalog());
  return c.products.find((p) => p.id === id) || null;
}

// ---------- search: name / SKU / brand / id, all tokens must match ----------
export async function searchProducts(q) {
  const query = String(q || '').trim().toLowerCase();
  if (!query) return [];
  const { products } = await getCatalog();
  const tokens = query.split(/\s+/);
  const hay = (p) => `${p.name} ${p.sku || ''} ${p.brand || ''} ${p.id}`.toLowerCase();
  return products
    .filter((p) => { const h = hay(p); return tokens.every((t) => h.includes(t)); })
    .sort((a, b) => {
      const rank = (p) => {
        const n = p.name.toLowerCase();
        return n === query || p.sku?.toLowerCase() === query || p.id === query ? 0 : n.startsWith(query) ? 1 : n.includes(query) ? 2 : 3;
      };
      return rank(a) - rank(b) || a.name.localeCompare(b.name);
    })
    .slice(0, 200);
}

import 'dotenv/config';
import { chromium } from 'playwright';
import { STORE_URL, productUrl } from './catalog.js';

const NAV_TIMEOUT = Number(process.env.SCRAPE_TIMEOUT_MS || 25000);
const RETRIES = Number(process.env.SCRAPE_RETRIES || 3);

/*
 * What INE's product page really does (from its bundle):
 *  1. Idle block: "Price hidden" + [Reveal price] button, DISABLED until the
 *     mouse made >=8 moves (>=40ms apart) and dwelled >=600ms over the block.
 *  2. Click -> challenge/session/price requests. The store randomly DROPS or
 *     DELAYS ~35% of clicks, and price API can 429/5xx (page retries 6x, then
 *     shows "Try again").
 *  3. Success block (.price-success) contains, in .price-main:
 *       - hidden decoys (.price-value, .amount[data-price])  -> WRONG prices
 *       - struck-through MRP                                  -> not the price
 *       - optional "Deal price X"                             -> not the price
 *       - the real price, font-size 2.4rem (class names vary per /api/layout)
 *       - "Updating…" + 45% opacity  => PROVISIONAL price; press "Refresh price"
 *     Price text format varies: ₹1,234 | ₹1 234 | ₹1.234,00 | ₹1,234/- (incl…) |
 *     fullwidth digits | nbsp+zero-width chars | "Rs. 1,234.00".
 *  4. Stock badge: .stock-badge.in-stock / .out-stock. OOS still has a price.
 *  5. A modal cookie banner (75% of loads, after 1.5–5s) blocks the page.
 */

// ---------------- price parsing ----------------
export function parsePrice(raw) {
  if (!raw) return null;
  let s = String(raw)
    .normalize('NFKC') // fullwidth digits -> ASCII, nbsp -> space
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\/-.*$/, '') // "₹1,234/- (incl. of all taxes)"
    .replace(/\(.*?\)/g, '')
    .replace(/[^\d.,\s]/g, '') // drop ₹ Rs INR letters
    .replace(/^[.\s]+/, '')
    .trim();
  if (!s) return null;
  if (/,\d{2}$/.test(s)) s = s.replace(/[.\s]/g, '').replace(',', '.'); // euro: 1.234,00
  else s = s.replace(/[,\s]/g, ''); // 1,234 | 1 234 | 12,34,567.00
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------- shared browser ----------------
const browsers = new Map();
async function getBrowser(headed) {
  let b = browsers.get(headed);
  if (!b || !b.isConnected()) {
    b = await chromium.launch({ headless: !headed });
    browsers.set(headed, b);
  }
  return b;
}
export async function closeBrowsers() {
  for (const b of browsers.values()) await b.close().catch(() => {});
  browsers.clear();
}

class IdentityError extends Error {} // wrong product page -> never retry, never save

// ---------------- page helpers ----------------
async function verifyIdentity(page, product) {
  await page.waitForSelector('.detail-card h1', { timeout: 15000 });
  const got = await page.evaluate(() => ({
    path: location.pathname,
    h1: document.querySelector('.detail-card h1')?.textContent?.trim() || '',
    brandLine: document.querySelector('.detail-brand')?.textContent?.trim() || '',
  }));
  const norm = (x) => String(x).replace(/\s+/g, ' ').trim().toLowerCase();
  if (!got.path.endsWith(`/product/${product.id}`))
    throw new IdentityError(`Wrong URL: expected /product/${product.id}, got ${got.path}`);
  if (product.sku && !norm(got.brandLine).includes(norm(`SKU ${product.sku}`)))
    throw new IdentityError(`SKU mismatch: expected ${product.sku}, page says "${got.brandLine}"`);
  if (product.name && norm(got.h1) !== norm(product.name))
    throw new IdentityError(`Name mismatch: expected "${product.name}", page says "${got.h1}"`);
  return got;
}

async function hoverPriceArea(page) {
  const area = page.locator('.price-block').first();
  await area.waitFor({ state: 'visible', timeout: 15000 });
  await area.scrollIntoViewIfNeeded();
  const box = await area.boundingBox();
  if (!box) throw new Error('Price block not visible');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(box.x + box.width * (0.15 + (i % 6) * 0.1), box.y + box.height * (0.3 + (i % 2) * 0.35));
    await page.waitForTimeout(70); // site ignores moves <40ms apart
  }
  await page.waitForTimeout(800); // >=600ms dwell
}

async function waitOutcome(page, ms) {
  try { await page.waitForSelector('.price-success, .price-error', { timeout: ms }); }
  catch { return 'timeout'; }
  return (await page.locator('.price-success').count()) ? 'success' : 'error';
}

// Get to the .price-success state, surviving dropped/delayed clicks and errors.
async function reveal(page) {
  for (let round = 1; round <= 6; round++) {
    if (await page.locator('.price-success').count()) return;
    await hoverPriceArea(page).catch(() => {});
    const btn = page.locator('.price-block button:has-text("Reveal price"), .price-block button:has-text("Try again")').first();
    if (await btn.count()) await btn.click({ timeout: 5000 }).catch(() => {});
    // click dropped? (no state change within 2.5s) -> next round
    const moved = await page.waitForSelector('.price-block:not(.price-idle)', { timeout: 2500 }).then(() => true).catch(() => false);
    if (!moved) continue;
    if ((await waitOutcome(page, 12000)) === 'success') return;
  }
  throw new Error('Price did not reveal after 6 rounds');
}

async function readQuote(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.price-success');
    const main = root?.querySelector('.price-main');
    const priceEl = main?.querySelector('[style*="2.4rem"]');
    if (!priceEl) return null;
    const badge = root.querySelector('.stock-badge');
    const deal = [...main.querySelectorAll('span')].find((s) => /deal price/i.test(s.textContent));
    return {
      priceText: priceEl.textContent,
      mrpText: main.querySelector('[style*="line-through"]')?.textContent || null,
      dealText: deal?.textContent || null,
      pending: /updating/i.test(main.innerText) || parseFloat(getComputedStyle(priceEl).opacity) < 1,
      stockClass: badge?.className || '',
      stockText: badge?.textContent || '',
      symbolSample: priceEl.textContent,
    };
  });
}

// Provisional ("Updating…") prices are refreshed until final.
async function finalQuote(page) {
  for (let i = 0; i < 8; i++) {
    await reveal(page);
    const q = await readQuote(page);
    if (q && !q.pending) return q;
    await page.getByRole('button', { name: /refresh price/i }).first().click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(1300); // covers the store's 900ms delayed-click path
  }
  throw new Error('Price still provisional ("Updating…") after 8 refreshes');
}

// ---------------- one scrape ----------------
async function scrapeOnce(product, headed) {
  const browser = await getBrowser(headed);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  });
  try {
    const page = await context.newPage();
    // Cookie modal blocks pointer events; auto-dismiss as soon as it appears.
    await page.addInitScript(() => {
      setInterval(() => document.querySelector('.cookie-overlay [aria-label="Accept cookies"]')?.click(), 150);
    });

    const url = productUrl(product.id); // built from ID, never from stored/client url
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    const ident = await verifyIdentity(page, product);

    const q = await finalQuote(page);
    const price = parsePrice(q.priceText);
    if (!price) throw new Error(`Could not parse price from "${q.priceText}"`);

    // OOS still has a price; stock is separate.
    const stock = /out-stock/.test(q.stockClass) ? false : /in-stock/.test(q.stockClass) ? true : null;
    const count = stock ? Number((q.stockText.match(/\d+/) || [])[0]) || null : 0;

    return {
      price,
      stock,
      stock_count: count,
      mrp: parsePrice(q.mrpText),
      deal_price: parsePrice(q.dealText),
      raw_price_text: q.priceText,
      title: ident.h1,
      sku_line: ident.brandLine,
      product_id: String(product.id),
      url,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

export async function scrapeProduct(product, { headed = false } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      console.log(`[SCRAPER] #${product.id} attempt ${attempt}/${RETRIES}`);
      const r = await scrapeOnce(product, headed);
      console.log(`[SCRAPER] #${product.id} ₹${r.price} stock=${r.stock} (raw "${r.raw_price_text}")`);
      return { ...r, attempts: attempt };
    } catch (e) {
      lastError = e;
      console.error(`[SCRAPER] #${product.id} attempt ${attempt} failed: ${e.message}`);
      if (e instanceof IdentityError) break; // wrong product: retrying can't help
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
  throw new Error(`Scrape failed: ${lastError?.message || 'unknown'}`);
}
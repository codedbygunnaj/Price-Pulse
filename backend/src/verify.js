// node verify.js            -> catalog completeness + duplicate check
// node verify.js 419        -> also scrape /product/419 (headed) and print everything
import { getCatalog, getCatalogProduct, closeCatalogBrowser } from './catalog.js';
import { scrapeProduct, closeBrowsers } from './scraper.js';

const c = await getCatalog({ force: true });
console.log(`Catalog: ${c.products.length}/${c.total} products, complete=${c.complete}, missing pages=[${c.missingPages}]`);
const skus = new Map();
for (const p of c.products) skus.set(p.sku, (skus.get(p.sku) || 0) + 1);
console.log('Duplicate SKUs:', [...skus].filter(([, n]) => n > 1).length);

const id = process.argv[2];
if (id) {
  const p = await getCatalogProduct(id);
  console.log('Canonical:', p);
  console.log('Scrape   :', await scrapeProduct(p, { headed: true }));
  console.log('-> Compare "price" with what you see on', p.url);
}
await closeBrowsers(); await closeCatalogBrowser();
process.exit(0);

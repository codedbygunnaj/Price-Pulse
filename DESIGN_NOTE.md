# PricePulse — Design Note

## 1. Overview

PricePulse is a full-stack product price tracker built for the INE Software Engineer Intern assignment. The main engineering goal is reliable scraping under an intentionally unreliable mock storefront.

The system supports product search, tracking, two-hour scheduled scraping, price/stock history, and per-product scrape logs.

## 2. Architecture

```text
React/Vercel
    │
    ▼
Node.js + Express/Render ◄──── cron-job.org (every 2 hours)
    │
    ▼
Playwright scraper
    │
    ▼
INE mock store

Node.js ───────────────► Supabase PostgreSQL
                          ├─ tracked_products
                          ├─ price_history
                          └─ scrape_logs
```

## 3. Product Identity

The INE catalog is treated as the source of truth for product identity. Search can use partial/full terms and relevant catalog fields. Once selected, the canonical product ID and URL are retained. This avoids associating scraped data with the wrong product because of an ambiguous search term or URL.

## 4. Scraping Strategy

The storefront contains browser-dependent behavior and delayed price rendering. A simple HTTP request is therefore not sufficient for the complete product path. Playwright is used where browser interaction is genuinely required; lighter catalog/API requests are used where possible.

The scraper does not trust the first price-like value it encounters. It waits for the expected successful/final price state and handles provisional updating states. It also avoids hidden/decoy price values by targeting the expected successful-price structure.

## 5. Retry and Failure Handling

A transient failure does not immediately become a permanent failure. Each product scrape is retried up to the configured retry count.

```text
Attempt 1 → valid result → save observation
      │
      └→ failure → Attempt 2 → valid result → save observation
                         │
                         └→ failure → Attempt 3 → valid result OR FAILED log
```

Retries are operational attempts, not separate successful price-history observations. If all attempts fail, the failure is recorded in `scrape_logs` and no invalid observation is added to `price_history`.

## 6. Correctness Checks

Before persistence, the scraper validates product identity such as ID/URL, SKU, and name. This reduces the risk of saving a valid-looking price against the wrong tracked product.

Stock is independent from price. An out-of-stock product can still have a valid price, so `stock=false` does not make an otherwise valid observation a failure.

## 7. Database Design

### `tracked_products`
Stores the canonical tracked product and its latest known state.

### `price_history`
Stores valid observations of price, stock, and scrape time.

### `scrape_logs`
Stores operational information such as attempted time, status, duration, number of attempts, and error message.

This separation is intentional: a failed scrape is an operational event, not a price observation.

## 8. Scheduling

The assignment requires scraping every two hours. Render free-tier instances can sleep, so the system uses cron-job.org as an external trigger.

```text
cron-job.org
     │ POST /api/cron/scrape
     │ X-Cron-Secret
     ▼
Render backend
     ▼
runAllTracked()
     ▼
tracked products → scrape → persist/log
```

The endpoint authenticates the shared secret, and the backend uses single-flight protection to avoid unnecessary overlapping scrape runs.

## 9. Deployment Trade-offs

### Playwright vs HTTP-only
Playwright was selected for the product path because the mock store requires browser interaction and delayed rendering. The trade-off is higher resource usage, so it is not used for every catalog operation.

### External cron vs internal scheduler
An external cron is more appropriate for a sleeping free-tier backend. The trade-off is an external dependency, mitigated by authenticated requests and status visibility.

### Separate history and logs
This adds database structure but makes the system auditable: successful observations remain clean while failures remain visible.

## 10. AI-Assisted Development: What Went Wrong

AI assistance was used during development, but suggestions were verified against actual build/runtime behavior.

A concrete deployment mistake occurred in the first Playwright deployment guidance. The initial Render build command used:

```bash
npx playwright install --with-deps chromium
```

On the Render build environment this attempted to install Linux system dependencies by switching to root and failed with:

```text
su: Authentication failure
```

The command was corrected to install the browser only:

```bash
npx playwright install chromium
```

That exposed a second runtime issue: the browser was installed into Playwright's default build cache while the runtime looked for a browser in that cache path after deployment. The deployment was corrected by using Playwright's hermetic browser path:

```text
PLAYWRIGHT_BROWSERS_PATH=0
```

for the installation and Render runtime environment. The actual Render logs, rather than the initial AI assumption, were used to diagnose both issues.

The broader lesson was that generated deployment commands must be validated against the target hosting environment; a command that is valid in a generic CI/Linux environment is not automatically valid on a managed build service.

## 11. Reliability Principles

The scraper follows four rules:

1. **Retry transient failures.**
2. **Validate before persisting.**
3. **Preserve failures instead of hiding them.**
4. **Never overwrite good data with an invalid scrape.**

These choices directly support the assignment's emphasis on unattended scraping reliability, correctness, and honest logging.

## 12. Final System

The final implementation provides product search and tracking, Supabase persistence, two-hour external scheduling, retry-based Playwright scraping, price/stock history, per-product logs, authenticated cron triggering, and deployment through Vercel + Render + Supabase.

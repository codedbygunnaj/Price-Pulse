# PricePulse — Product Price Tracker

PricePulse is a full-stack product price tracker built for the INE Software Engineer Intern assignment. It lets users search the INE mock store, track products, scrape price and stock every two hours, view history, and inspect scrape logs.

## Features
- Partial/full product search and canonical product selection
- Persistent tracked products in Supabase PostgreSQL
- Scheduled scraping every 2 hours through cron-job.org
- Playwright scraping for browser-dependent/delayed content
- Retries for transient failures
- Validation before saving scraped data
- Price and stock history
- Per-product SUCCESS / RETRIED / FAILED scrape logs
- Headed scraper mode for demonstration/debugging

## Architecture
```text
React/Vercel → Node.js + Express/Render → Playwright → INE Mock Store
                                      ↓
                               Supabase PostgreSQL
                                      ↑
                               cron-job.org
                                (every 2 hours)
```

## Stack
| Layer | Technology |
|---|---|
| Frontend | React.js |
| Backend | Node.js + Express |
| Database | Supabase PostgreSQL |
| Scraping | Playwright |
| Scheduler | cron-job.org |
| Frontend hosting | Vercel |
| Backend hosting | Render |

## Repository Structure
```text
Price-Pulse/
├── backend/
│   ├── src/
│   │   ├── server.js
│   │   ├── scraper.js
│   │   ├── catalog.js
│   │   └── store.js
│   ├── package.json
│   └── ...
├── db/schema.sql
├── frontend/
├── README.md
└── DESIGN_NOTE.md
```

## Local Setup

### Backend
```bash
cd backend
npm install
npx playwright install chromium
```

Create `backend/.env`:
```env
PORT=4000
STORE_URL=https://demo.inelabteamdev.com
USE_SUPABASE=true
SUPABASE_URL=<your-supabase-url>
SUPABASE_SERVICE_ROLE_KEY=<your-supabase-service-role-key>
CRON_SECRET=<your-cron-secret>
SCRAPE_TIMEOUT_MS=20000
SCRAPE_RETRIES=3
HISTORY_LIMIT=100
```

Run:
```bash
node src/server.js
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```
Configure the frontend API base URL for the backend.

## Database
Run `db/schema.sql` in Supabase. The schema contains:
- `tracked_products` — canonical product and latest state
- `price_history` — successful price/stock observations
- `scrape_logs` — every scrape outcome and diagnostics

## Environment Variables
| Variable | Purpose |
|---|---|
| `STORE_URL` | INE mock store base URL |
| `USE_SUPABASE` | Enables Supabase persistence |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase secret |
| `CRON_SECRET` | Authenticates cron requests |
| `SCRAPE_TIMEOUT_MS` | Scrape timeout |
| `SCRAPE_RETRIES` | Retry count |
| `HISTORY_LIMIT` | History response limit |
| `PLAYWRIGHT_BROWSERS_PATH` | Render browser path; set to `0` |
| `PORT` | Local server port; Render supplies its own port |

Never expose `SUPABASE_SERVICE_ROLE_KEY` or `CRON_SECRET` to the frontend or commit them to Git.

## Scheduled Scraping
The assignment requires a fixed two-hour schedule. cron-job.org sends:
```text
POST https://<render-service>/api/cron/scrape
X-Cron-Secret: <same value as CRON_SECRET>
```
The endpoint authenticates the request and starts the scrape in the background. Single-flight protection prevents unnecessary overlapping full runs.

## Scraping Reliability
The mock store can delay content, return transient errors, and expose misleading price-related values. PricePulse therefore:

1. Retries failed attempts.
2. Waits for the final/valid price state instead of trusting an initial provisional value.
3. Targets the expected successful-price structure instead of blindly taking the first price-like element.
4. Treats stock independently from price, so an out-of-stock product can still have a valid price.
5. Verifies product identity (ID/URL/SKU/name) before persistence.
6. Records failures honestly and does not create fake successful history entries.
7. Does not overwrite valid current data with empty/invalid scrape results.

## API Overview
```text
GET  /api/health
GET  /api/products/search
POST /api/tracked-products
GET  /api/tracked-products
GET  /api/tracked-products/:id
GET  /api/tracked-products/:id/history
GET  /api/tracked-products/:id/logs
POST /api/scraper/run
GET  /api/scraper/status
POST /api/cron/scrape
```

## Deployment
### Vercel
Deploy `frontend/` and configure its backend API URL.

### Render
Root directory:
```text
backend
```
Build command:
```bash
npm install && PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium
```
Start command:
```bash
node src/server.js
```
Render environment:
```text
PLAYWRIGHT_BROWSERS_PATH=0
```
The local Playwright browser path keeps build-time installation and runtime lookup consistent.

### Supabase
Run the schema and configure the backend with the project URL and server-side secret.

### cron-job.org
Configure an authenticated POST to `/api/cron/scrape` every two hours.

## Design Decisions
**Playwright:** The product page genuinely requires browser interaction/delayed rendering, so Playwright is used for the difficult product path while lightweight catalog/API access is used where appropriate.

**External cron:** Render free-tier services can sleep, so cron-job.org provides the two-hour trigger instead of relying on an always-running internal loop.

**Separate history and logs:** Price history represents valid observations; scrape logs represent operational attempts. This keeps failures visible without turning them into fake price data.

## Assignment Deliverables
- Hosted live site
- Public GitHub repository
- 2–4 minute headed-mode screen recording showing slow/failing response handling
- README
- Design note
- PDF resume

Submission email:
```text
To: sstephen@ine.com
CC: ssingh@ine.com
Subject: First Round: Software Engineer Intern Assignment - <Your Name>
```
Deadline: **September 20, 2026 — 11:59 PM IST**.

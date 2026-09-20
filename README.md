# INE PricePulse — Prototype

React + Vite frontend, Express backend, Playwright scraper, Supabase/PostgreSQL schema.

## What is included
- Product search/tracking API and dashboard
- Manual `Refresh now` scrape for a tracked product
- `Run all` endpoint for cron-job.org
- Retry + timeout handling
- Validation before persisting a price
- Current observed price + bounded last-N history
- Honest scrape log: SUCCESS / RETRIED / FAILED
- Supabase schema
- Headed scraper support for the required recording
- In-memory demo mode when Supabase is disabled

The mock mode lets the UI/API run before database credentials are configured. The real scraper targets only the INE mock store configured by `STORE_URL`.

## Run locally

### Backend
```bash
cd backend
npm install
npx playwright install chromium
copy .env.example .env   # Windows
npm run dev
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```
Open http://localhost:5173.

## Supabase
1. Create a Supabase project.
2. Run `db/schema.sql` in SQL Editor.
3. Set `USE_SUPABASE=true`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` in `backend/.env`.
4. Restart backend.

## Cron
Point cron-job.org at:
`POST https://YOUR-RENDER-APP/api/scraper/run`

Recommended: keep the endpoint protected with a secret before production deployment. For the assignment's fixed schedule, configure it for every 2 hours.

## Headed run
For the observable demo:
```bash
cd backend
HEADED=true npm run scrape:headed
```
Or call `/api/scraper/run?headed=true` while the backend is running.

## Design choice: bounded history
The current product row stores the latest successful observation. `price_history` keeps a bounded number of recent observations (default 100 in demo mode), rather than growing forever. This still supports the required price-history chart while keeping retention bounded. Scrape attempts remain separately logged so failures are not silently discarded.

## Important semantic
A displayed value is an **observed price at `last_scraped_at`**, not a guaranteed checkout price. If this is ever extended into an ordering flow, checkout must revalidate the authoritative current price server-side.

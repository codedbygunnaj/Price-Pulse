create table if not exists tracked_products (
  id text primary key,
  name text not null,
  url text not null,
  current_price numeric,
  current_stock boolean,
  last_scraped_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists price_history (
  id bigint generated always as identity primary key,
  tracked_product_id text not null references tracked_products(id) on delete cascade,
  price numeric not null,
  stock boolean,
  scraped_at timestamptz not null
);
create index if not exists idx_price_history_product_time on price_history(tracked_product_id, scraped_at desc);

create table if not exists scrape_logs (
  id bigint generated always as identity primary key,
  tracked_product_id text not null references tracked_products(id) on delete cascade,
  attempted_at timestamptz not null,
  status text not null check (status in ('SUCCESS','RETRIED','FAILED')),
  duration_ms integer,
  attempts integer,
  error_message text
);
create index if not exists idx_scrape_logs_product_time on scrape_logs(tracked_product_id, attempted_at desc);

-- Bounded history: retain the newest N observations per product (e.g. 100).
-- Run periodically if you want DB-level retention:
-- delete from price_history ph where ph.id in (
--   select id from price_history x where x.tracked_product_id = ph.tracked_product_id
--   order by scraped_at desc offset 100
-- );

-- identity columns (run once on existing DB)
alter table tracked_products add column if not exists brand text;
alter table tracked_products add column if not exists sku text;
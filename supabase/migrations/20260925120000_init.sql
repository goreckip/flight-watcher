-- Flight Watcher: initial schema

-- What to monitor. One row = one search you care about.
create table public.watches (
  id           bigint generated always as identity primary key,
  name         text        not null,
  origins      text[]      not null,              -- IATA airport or city codes, e.g. {GDN} or {WAW}
  destinations text[]      not null,              -- e.g. {BCN,AGP,MAD} or {TYO,OSA}
  depart_from  date        not null,              -- earliest departure date
  depart_to    date        not null,              -- latest departure date
  stay_min     int         not null,              -- nights at destination
  stay_max     int         not null,
  direct_only  boolean     not null default true,
  drop_pct     numeric     not null default 10,   -- alert when price falls this % below baseline
  currency     text        not null default 'PLN',
  active       boolean     not null default true,
  created_at   timestamptz not null default now(),
  constraint watches_dates_ok  check (depart_to >= depart_from),
  constraint watches_stay_ok   check (stay_min > 0 and stay_max >= stay_min),
  constraint watches_drop_ok   check (drop_pct > 0 and drop_pct < 100),
  constraint watches_codes_ok  check (cardinality(origins) > 0 and cardinality(destinations) > 0)
);

-- Every fare seen, once per day. The source of truth for trends.
create table public.price_snapshots (
  id           bigint generated always as identity primary key,
  watch_id     bigint      not null references public.watches (id) on delete cascade,
  checked_on   date        not null default current_date,
  origin       text        not null,
  destination  text        not null,
  depart_date  date        not null,
  return_date  date        not null,
  price        numeric     not null,
  currency     text        not null,
  airline      text,
  transfers    int         not null default 0,
  link         text,
  created_at   timestamptz not null default now(),
  -- re-running on the same day updates instead of duplicating
  constraint price_snapshots_one_per_day
    unique (watch_id, checked_on, origin, destination, depart_date, return_date)
);

create index price_snapshots_route_idx
  on public.price_snapshots (watch_id, origin, destination, checked_on);

-- Alerts already emailed, so the same drop is not reported twice.
create table public.alerts (
  id             bigint generated always as identity primary key,
  watch_id       bigint      not null references public.watches (id) on delete cascade,
  origin         text        not null,
  destination    text        not null,
  depart_date    date        not null,
  return_date    date        not null,
  price          numeric     not null,
  baseline_price numeric     not null,
  drop_pct       numeric     not null,
  currency       text        not null,
  sent_at        timestamptz not null default now()
);

create index alerts_route_idx
  on public.alerts (watch_id, origin, destination, sent_at);

-- Cheapest fare per route per day: the series used for baselines and trend charts.
create view public.route_daily_min
with (security_invoker = true) as
select distinct on (watch_id, origin, destination, checked_on)
  watch_id, origin, destination, checked_on,
  price, currency, depart_date, return_date, airline, link
from public.price_snapshots
order by watch_id, origin, destination, checked_on, price;

-- Lock everything down: no policies means only the service role (the Edge Function) can read/write.
alter table public.watches         enable row level security;
alter table public.price_snapshots enable row level security;
alter table public.alerts          enable row level security;

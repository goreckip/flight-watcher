-- Second price source: Google Flights (via SerpApi), searched for exact date pairs on a rotation.

-- Where a fare came from, the real group total (Google prices the whole party), and Google's
-- "low / typical / high" verdict for the route.
alter table public.price_snapshots
  add column source      text    not null default 'travelpayouts',
  add column price_total numeric,
  add column price_level text;

alter table public.price_snapshots drop constraint price_snapshots_one_per_day;
alter table public.price_snapshots add constraint price_snapshots_one_per_day
  unique (watch_id, checked_on, source, origin, destination, depart_date, return_date);

-- Every exact-date search, including ones with no results: drives the rotation and the daily quota.
create table public.search_log (
  id          bigint generated always as identity primary key,
  watch_id    bigint      not null references public.watches (id) on delete cascade,
  source      text        not null,
  checked_on  date        not null default current_date,
  depart_date date        not null,
  return_date date        not null,
  results     int         not null default 0,
  error       text,
  created_at  timestamptz not null default now()
);
create index search_log_watch_idx on public.search_log (watch_id, source, checked_on);
alter table public.search_log enable row level security;

-- Best known fare per route per day.
-- Travelpayouts is re-read in full every day, so only that day's fares count.
-- Google date pairs are re-searched on a rotation, so a Google fare stays "current" for
-- 12 days (or until that pair is searched again). Without this, the daily minimum would jump
-- around depending on which dates happened to be searched that day.
drop view public.route_daily_min;

create view public.route_daily_best
with (security_invoker = true) as
with days as (
  select distinct watch_id, checked_on as day from public.price_snapshots
),
latest as (
  select distinct on (d.watch_id, d.day, s.source, s.origin, s.destination, s.depart_date, s.return_date)
    d.watch_id, d.day, s.source, s.origin, s.destination, s.depart_date, s.return_date,
    s.price, s.price_total, s.price_level, s.currency, s.airline, s.transfers,
    s.duration_to, s.duration_back, s.link, s.checked_on as seen_on
  from days d
  join public.price_snapshots s
    on s.watch_id = d.watch_id
   and s.checked_on <= d.day
   and s.checked_on > d.day - case when s.source = 'google' then 12 else 1 end
  order by d.watch_id, d.day, s.source, s.origin, s.destination, s.depart_date, s.return_date, s.checked_on desc
)
select distinct on (watch_id, origin, destination, day)
  watch_id, origin, destination, day as checked_on,
  price, price_total, price_level, currency, depart_date, return_date,
  airline, transfers, duration_to, duration_back, link, source, seen_on
from latest
order by watch_id, origin, destination, day, price;

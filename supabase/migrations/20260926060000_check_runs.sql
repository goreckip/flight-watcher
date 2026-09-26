-- Record every price check (scheduled or manual) so the dashboard can show what happened.
create table public.check_runs (
  id              bigint generated always as identity primary key,
  trigger         text        not null default 'schedule', -- schedule | manual
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  google_searches int,
  fares           int,
  alerts_sent     int,
  errors          jsonb,
  failed          text
);
create index check_runs_started_idx on public.check_runs (started_at desc);
alter table public.check_runs enable row level security;

-- One row per day from a watch's first fare until today, so the chart and baselines have a
-- point every day even when that day's searches found nothing new. Google fares carry forward
-- for 12 days; Aviasales fares count only on the day they were seen.
create or replace view public.route_daily_best
with (security_invoker = true) as
with bounds as (
  select watch_id, min(checked_on) as first_day from public.price_snapshots group by watch_id
),
days as (
  select b.watch_id, d::date as day
  from bounds b, generate_series(b.first_day, current_date, interval '1 day') as d
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

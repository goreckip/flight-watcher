-- Run the schedule inside Supabase (pg_cron + pg_net) instead of GitHub Actions, whose free
-- scheduler started runs hours late. Also backfill per-check history from before check_points.

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
create extension if not exists pg_net with schema extensions;

-- Settings the scheduler needs. RLS on, no policies: only the service role and postgres can read.
-- cron_secret and functions_url are written by check-prices during deploy (x-setup request).
create table if not exists public.app_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table public.app_config enable row level security;

-- Call one of our Edge Functions if it's one of the given hours (and weekday) in Warsaw.
-- Scheduled hourly, so Warsaw's summer/winter time switch needs no special handling.
create or replace function public.call_function_if_due(fn text, local_hours int[], local_dow int default null)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  local_now timestamp := now() at time zone 'Europe/Warsaw';
  base      text;
  secret    text;
begin
  if not (extract(hour from local_now)::int = any (local_hours)) then return; end if;
  if local_dow is not null and extract(dow from local_now)::int <> local_dow then return; end if;

  select value into base   from public.app_config where key = 'functions_url';
  select value into secret from public.app_config where key = 'cron_secret';
  if base is null or secret is null then
    raise warning 'call_function_if_due: app_config not set up yet';
    return;
  end if;

  perform net.http_post(
    url := base || '/' || fn,
    headers := jsonb_build_object('x-cron-secret', secret, 'x-trigger', 'schedule', 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
end;
$$;

-- Not callable through the public API.
revoke execute on function public.call_function_if_due(text, int[], int) from public, anon, authenticated;

-- Price checks at 07:17, 14:05 and 20:05 Warsaw time; weekly summary Sundays 18:03 (dow 0 = Sunday).
select cron.schedule('check-prices-morning', '17 * * * *', $$select public.call_function_if_due('check-prices', array[7])$$);
select cron.schedule('check-prices-day',     '5 * * * *',  $$select public.call_function_if_due('check-prices', array[14, 20])$$);
select cron.schedule('weekly-digest',        '3 * * * *',  $$select public.call_function_if_due('weekly-digest', array[18], 0)$$);

-- ---------- backfill: per-check history from before check_points / price_observations existed ----------

-- Every Google fare seen so far, as a time-stamped observation.
insert into public.price_observations
  (observed_at, watch_id, source, origin, destination, depart_date, return_date, price, price_total)
select s.created_at, s.watch_id, s.source, s.origin, s.destination, s.depart_date, s.return_date, s.price, s.price_total
from public.price_snapshots s
where s.source = 'google'
  and not exists (
    select 1 from public.price_observations o
    where o.watch_id = s.watch_id and o.source = s.source
      and o.origin = s.origin and o.destination = s.destination
      and o.depart_date = s.depart_date and o.return_date = s.return_date
      and o.observed_at::date = s.created_at::date
  );

-- A chart point at each earlier Google search: the best Google fare known at that moment.
with first_point as (
  select watch_id, min(checked_at) as t from public.check_points group by watch_id
),
times as (
  select distinct l.watch_id, date_trunc('minute', l.created_at) as at
  from public.search_log l
  left join first_point f on f.watch_id = l.watch_id
  where l.source = 'google' and (f.t is null or l.created_at < f.t - interval '1 minute')
)
insert into public.check_points
  (checked_at, watch_id, origin, destination, price, price_total, price_level, currency,
   depart_date, return_date, airline, source)
select distinct on (t.watch_id, t.at, s.origin, s.destination)
  t.at + interval '59 seconds', t.watch_id, s.origin, s.destination, s.price, s.price_total, s.price_level,
  s.currency, s.depart_date, s.return_date, s.airline, s.source
from times t
join public.price_snapshots s
  on s.watch_id = t.watch_id and s.source = 'google'
 and s.created_at <= t.at + interval '1 minute'
 and s.created_at > t.at - interval '12 days'
order by t.watch_id, t.at, s.origin, s.destination, s.price;

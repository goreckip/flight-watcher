-- Time-stamped price history at check granularity (price_snapshots keeps one row per day).

-- Every fare seen by every check, append-only. Used to measure whether the same itinerary
-- is cheaper at certain times of day or days of the week.
create table public.price_observations (
  id           bigint generated always as identity primary key,
  run_id       bigint      references public.check_runs (id) on delete set null,
  observed_at  timestamptz not null default now(),
  watch_id     bigint      not null references public.watches (id) on delete cascade,
  source       text        not null,
  origin       text        not null,
  destination  text        not null,
  depart_date  date        not null,
  return_date  date        not null,
  price        numeric     not null,
  price_total  numeric
);
create index price_observations_watch_idx on public.price_observations (watch_id, observed_at);
alter table public.price_observations enable row level security;

-- The best known fare per route at the end of each check: one chart point per check.
create table public.check_points (
  id           bigint generated always as identity primary key,
  run_id       bigint      references public.check_runs (id) on delete set null,
  checked_at   timestamptz not null default now(),
  watch_id     bigint      not null references public.watches (id) on delete cascade,
  origin       text        not null,
  destination  text        not null,
  price        numeric     not null,
  price_total  numeric,
  price_level  text,
  currency     text        not null,
  depart_date  date        not null,
  return_date  date        not null,
  airline      text,
  source       text        not null
);
create index check_points_watch_idx on public.check_points (watch_id, checked_at);
alter table public.check_points enable row level security;

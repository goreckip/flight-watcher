-- Replace direct_only with a max number of stops, add a max journey time per direction,
-- and record who is travelling so alerts can show a family total.

alter table public.watches
  add column max_transfers   int   not null default 0,   -- 0 = direct only, 1 = up to one stop, ...
  add column max_leg_minutes int,                        -- max door-to-door time per direction; null = no limit
  add column adults          int   not null default 1,
  add column child_ages      int[] not null default '{}',
  add constraint watches_transfers_ok  check (max_transfers between 0 and 3),
  add constraint watches_leg_ok        check (max_leg_minutes is null or max_leg_minutes > 0),
  add constraint watches_adults_ok     check (adults between 1 and 9);

update public.watches set max_transfers = case when direct_only then 0 else 2 end;

alter table public.watches drop column direct_only;

-- Journey time per direction, in minutes, as reported by the price source.
alter table public.price_snapshots
  add column duration_to   int,
  add column duration_back int;

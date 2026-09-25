-- Latest allowed return date, so the whole trip fits a travel window (e.g. a school break).
alter table public.watches
  add column return_by date,
  add constraint watches_return_ok check (return_by is null or return_by > depart_from);

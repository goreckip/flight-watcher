-- Allow day trips: 0 nights means out and back on the same day.
alter table public.watches
  drop constraint watches_stay_ok,
  add constraint watches_stay_ok check (stay_min >= 0 and stay_max >= stay_min);

-- With 0 nights the whole trip can fit in a single day, so "back by" may equal the first departure day.
alter table public.watches
  drop constraint watches_return_ok,
  add constraint watches_return_ok check (return_by is null or return_by >= depart_from);

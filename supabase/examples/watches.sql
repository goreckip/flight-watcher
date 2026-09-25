-- Watches. Paste into Supabase → SQL Editor and run.
-- Codes can be airports (GDN, ATH) or cities (WAW = Chopin + Modlin, TYO = Narita + Haneda).
--   max_transfers   : stops allowed per direction (0 = direct only)
--   max_leg_minutes : max journey time per direction, including the connection (null = no limit)
--   adults / child_ages : used for the estimated family total in alerts

-- (The web dashboard does the same thing through a form.)
--   depart_to = return_by − stay_min, i.e. the latest departure that still gets you back in time

insert into public.watches
  (name, origins, destinations, depart_from, depart_to, return_by, stay_min, stay_max,
   max_transfers, max_leg_minutes, adults, child_ages, drop_pct)
values
  -- Gdansk → Athens, winter break 2027: 5–7 nights, back by 14 Feb, max 1 stop, max 6h30 each way, 2 adults + 3 kids
  ('Athens winter break', '{GDN}', '{ATH}', '2027-01-29', '2027-02-09', '2027-02-14', 5, 7,
   1, 390, 2, '{3,7,9}', 10);

-- More ideas for later:
-- ('Spain from Gdansk', '{GDN}', '{BCN,AGP,MAD}', '2027-04-15', '2027-06-15', 5, 8, 0, null, 1, '{}', 10),
-- ('Japan spring 2027', '{GDN,WAW,BER}', '{TYO,OSA}', '2027-04-01', '2027-06-16', 14, 28, 1, null, 1, '{}', 10)

-- Handy queries:
-- select * from watches;
-- update watches set active = false where id = 1;
-- select * from route_daily_min where watch_id = 1 order by checked_on;
-- select * from price_snapshots where watch_id = 1 and checked_on = current_date order by price;
-- select * from alerts order by sent_at desc;

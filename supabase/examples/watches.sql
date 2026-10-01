-- Watches. Paste into Supabase → SQL Editor and run.
-- Codes can be airports (KRK, LIS) or cities (WAW = Chopin + Modlin, TYO = Narita + Haneda).
--   max_transfers   : stops allowed per direction (0 = direct only)
--   max_leg_minutes : max journey time per direction, including the connection (null = no limit)
--   adults / child_ages : used for the estimated family total in alerts

-- (The web dashboard does the same thing through a form.)
--   depart_to = return_by − stay_min, i.e. the latest departure that still gets you back in time

insert into public.watches
  (name, origins, destinations, depart_from, depart_to, return_by, stay_min, stay_max,
   max_transfers, max_leg_minutes, adults, child_ages, drop_pct)
values
  -- Warsaw → Lisbon over Easter 2027: 6–9 nights, back by 11 Apr, max 1 stop, max 5h each way, 2 adults + 2 kids
  ('Lisbon spring break', '{WAW}', '{LIS}', '2027-03-27', '2027-04-05', '2027-04-11', 6, 9,
   1, 300, 2, '{6,10}', 10);

-- More ideas (same columns as above):
-- ('Spain in May', '{KRK}', '{BCN,AGP,VLC}', '2027-05-01', '2027-05-24', '2027-05-31', 4, 7, 0, null, 2, '{}', 10),
-- ('Japan spring 2027', '{KRK,WAW,BER}', '{TYO,OSA}', '2027-04-01', '2027-06-16', '2027-06-30', 14, 28, 1, null, 1, '{}', 10)

-- Handy queries:
-- select * from watches;
-- update watches set active = false where id = 1;
-- select * from route_daily_best where watch_id = 1 order by checked_on;
-- select * from price_snapshots where watch_id = 1 and checked_on = current_date order by price;
-- select * from alerts order by sent_at desc;

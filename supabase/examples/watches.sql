-- Example watches. Paste into Supabase → SQL Editor and adjust dates before running.
-- Codes can be airports (KTW, BCN) or cities (WAW = Chopin + Modlin, TYO = Narita + Haneda, OSA = Kansai + Itami).

insert into public.watches
  (name, origins, destinations, depart_from, depart_to, stay_min, stay_max, direct_only, drop_pct)
values
  -- Example 1: Katowice → Spain, 5–8 nights, direct only, alert on >10% drop
  ('Spain from Katowice', '{KTW}', '{BCN,AGP,MAD}', '2027-04-15', '2027-06-15', 5, 8, true, 10),

  -- Example 2: Japan in Apr–Jun for 2+ weeks, from Katowice / Warsaw / Berlin, connections allowed
  ('Japan spring 2027', '{KTW,WAW,BER}', '{TYO,OSA}', '2027-04-01', '2027-06-16', 14, 28, false, 10);

-- Handy queries:
-- select * from watches;
-- update watches set active = false where id = 2;
-- select * from route_daily_min where watch_id = 1 order by origin, destination, checked_on;
-- select * from alerts order by sent_at desc;

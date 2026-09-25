import { test } from "node:test";
import assert from "node:assert/strict";
import { digestHtml, digestSubject, sparkline, weeklyStats } from "../supabase/functions/_shared/digest.ts";
import type { DailyBest } from "../supabase/functions/_shared/digest.ts";
import type { Watch } from "../supabase/functions/check-prices/logic.ts";

const watch: Watch = {
  id: 1, name: "Athens winter break", origins: ["GDN"], destinations: ["ATH"],
  depart_from: "2027-01-29", depart_to: "2027-02-09", return_by: "2027-02-14",
  stay_min: 5, stay_max: 7, max_transfers: 1, max_leg_minutes: 390,
  drop_pct: 10, currency: "PLN", adults: 2, child_ages: [3, 7, 9],
};

const row = (checked_on: string, price: number, extra: Partial<DailyBest> = {}): DailyBest => ({
  watch_id: 1, origin: "GDN", destination: "ATH", checked_on, price, price_total: price * 5,
  price_level: "typical", depart_date: "2027-02-02", return_date: "2027-02-08", airline: "KLM",
  source: "google", ...extra,
});

test("weeklyStats: best now, change vs a week ago, 7-day range and series", () => {
  const rows = [
    row("2026-09-18", 1200),
    row("2026-09-20", 1150),
    row("2026-09-22", 1100),
    row("2026-09-22", 1300, { destination: "SKG" }), // other route, same day: min wins
    row("2026-09-25", 1080),
  ];
  const s = weeklyStats(rows, "2026-09-25")!;
  assert.equal(s.best.price, 1080);
  assert.equal(s.weekAgo!.checked_on, "2026-09-18");
  assert.equal(s.changePct, -10);
  assert.equal(s.low, 1080);
  assert.equal(s.high, 1150);
  assert.deepEqual(s.series, [null, 1150, null, 1100, null, null, 1080]);
});

test("weeklyStats: no week-ago data yet, and no data at all", () => {
  assert.equal(weeklyStats([row("2026-09-25", 1000)], "2026-09-25")!.changePct, null);
  assert.equal(weeklyStats([], "2026-09-25"), null);
});

test("sparkline scales to the range and marks gaps", () => {
  assert.equal(sparkline([100, null, 200, 150]), "▁·█▅");
  assert.equal(sparkline([5, 5]), "▄▄");
  assert.equal(sparkline([null, null]), "");
});

test("digest subject and HTML use the group total", () => {
  const stats = weeklyStats([row("2026-09-18", 1200), row("2026-09-25", 1076)], "2026-09-25");
  const items = [{ watch, stats, topFares: [], coverage: { checked: 3, total: 33 }, alertsThisWeek: 0 }];
  assert.equal(digestSubject(items), "Weekly flight summary: Athens winter break 5380 PLN for 5 (▼10.3%)");
  const html = digestHtml(items, { dashboardUrl: "https://example.test/", searchesLeft: 90 });
  assert.match(html, /Cheapest now/);
  assert.match(html, /3 of 33 date options/);
  assert.match(html, /searches left this month: 90/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { slotOf, timingInsight, weekdayOf } from "../supabase/functions/_shared/timing.ts";
import type { Observation } from "../supabase/functions/_shared/timing.ts";

const obs = (price: number, observed_at: string, depart = "2027-02-02"): Observation => ({
  source: "google", origin: "GDN", destination: "ATH", depart_date: depart, return_date: "2027-02-08",
  price, observed_at,
});

test("slots and weekdays use Warsaw time", () => {
  // 05:17 UTC in September = 07:17 Warsaw (UTC+2)
  assert.equal(slotOf("2026-09-26T05:17:00Z"), "morning");
  assert.equal(slotOf("2026-09-26T12:05:00Z"), "afternoon");
  assert.equal(slotOf("2026-09-26T18:05:00Z"), "evening");
  // 23:30 UTC Saturday = 01:30 Sunday in Warsaw
  assert.equal(weekdayOf("2026-09-26T23:30:00Z"), "Sun");
});

test("deviation is measured against the same itinerary's own average", () => {
  const insight = timingInsight([
    // itinerary A: evening cheaper
    obs(1000, "2026-09-26T05:17:00Z"),
    obs(1000, "2026-09-26T12:05:00Z"),
    obs(940, "2026-09-26T18:05:00Z"),
    // itinerary B (much pricier trip): same pattern; absolute prices must not matter
    obs(2000, "2026-09-26T05:17:00Z", "2027-02-06"),
    obs(2000, "2026-09-26T12:05:00Z", "2027-02-06"),
    obs(1880, "2026-09-26T18:05:00Z", "2027-02-06"),
    // seen once: ignored
    obs(10, "2026-09-26T18:05:00Z", "2027-02-09"),
  ]);
  assert.equal(insight.itineraries, 2);
  assert.equal(insight.observations, 6);
  const evening = insight.bySlot.find((b) => b.key === "evening")!;
  const morning = insight.bySlot.find((b) => b.key === "morning")!;
  assert.ok(evening.avgDeviationPct < 0 && morning.avgDeviationPct > 0);
  assert.equal(evening.avgDeviationPct, -4.1);
  assert.equal(insight.reliable, false); // too few observations
});

test("marked reliable only with enough observations in at least two slots", () => {
  const list: Observation[] = [];
  for (let d = 1; d <= 12; d++) {
    const day = String(d).padStart(2, "0");
    list.push(obs(1000, `2026-10-${day}T05:17:00Z`), obs(1010, `2026-10-${day}T12:05:00Z`), obs(990, `2026-10-${day}T18:05:00Z`));
  }
  const insight = timingInsight(list);
  assert.equal(insight.reliable, true);
  assert.equal(insight.byWeekday.length, 7);
});

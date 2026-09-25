import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSearchPlan,
  cheapestPerRoute,
  cheapestPerTrip,
  evaluateRoute,
  median,
  monthsBetween,
  payingSeats,
  ticketsToTrips,
} from "../supabase/functions/check-prices/logic.ts";
import type { TpTicket, Trip, Watch } from "../supabase/functions/check-prices/logic.ts";

const spain: Watch = {
  id: 1,
  name: "Spain",
  origins: ["GDN"],
  destinations: ["BCN", "AGP"],
  depart_from: "2027-05-10",
  depart_to: "2027-06-20",
  return_by: null,
  stay_min: 5,
  stay_max: 8,
  max_transfers: 0,
  max_leg_minutes: null,
  drop_pct: 10,
  currency: "PLN",
  adults: 1,
  child_ages: [],
};

const ticket = (depart: string, ret: string, price: number, extra: Partial<TpTicket> = {}): TpTicket => ({
  price,
  airline: "FR",
  departure_at: `${depart}T06:00:00+02:00`,
  return_at: `${ret}T09:00:00+02:00`,
  transfers: 0,
  return_transfers: 0,
  link: "/search/x",
  ...extra,
});

test("monthsBetween spans year boundaries", () => {
  assert.deepEqual(monthsBetween("2026-11-15", "2027-02-01"), ["2026-11", "2026-12", "2027-01", "2027-02"]);
  assert.deepEqual(monthsBetween("2027-05-10", "2027-05-30"), ["2027-05"]);
});

test("buildSearchPlan: origin × destination × month", () => {
  const plan = buildSearchPlan(spain, "2026-09-25");
  assert.equal(plan.length, 4); // 1 origin × 2 destinations × 2 months
  assert.deepEqual(plan[0], { origin: "GDN", destination: "BCN", month: "2027-05" });
});

test("buildSearchPlan skips months already in the past", () => {
  assert.deepEqual(buildSearchPlan(spain, "2027-06-01").map((s) => s.month), ["2027-06", "2027-06"]);
  assert.deepEqual(buildSearchPlan(spain, "2027-07-01"), []);
});

test("ticketsToTrips applies date window, stay length and direct-only", () => {
  const req = { origin: "GDN", destination: "BCN", month: "2027-05" };
  const trips = ticketsToTrips(
    [
      ticket("2027-05-12", "2027-05-18", 400), // ok: 6 nights
      ticket("2027-05-12", "2027-05-15", 300), // too short
      ticket("2027-05-12", "2027-05-25", 300), // too long
      ticket("2027-05-05", "2027-05-11", 300), // before window
      ticket("2027-05-12", "2027-05-18", 250, { transfers: 1 }), // not direct
      ticket("2027-05-12", "2027-05-18", 250, { return_at: undefined }), // one-way
    ],
    req,
    spain,
    "2026-09-25",
  );
  assert.equal(trips.length, 1);
  assert.equal(trips[0].price, 400);
  assert.equal(trips[0].link, "https://www.aviasales.com/search/x");
});

test("ticketsToTrips allows up to max_transfers stops", () => {
  const req = { origin: "GDN", destination: "BCN", month: "2027-05" };
  const oneStop = { ...spain, max_transfers: 1 };
  const trips = ticketsToTrips(
    [
      ticket("2027-05-12", "2027-05-18", 250, { transfers: 1 }),
      ticket("2027-05-12", "2027-05-18", 200, { return_transfers: 2 }),
    ],
    req,
    oneStop,
    "2026-09-25",
  );
  assert.equal(trips.length, 1);
  assert.equal(trips[0].transfers, 1);
});

test("ticketsToTrips enforces max journey time per direction", () => {
  const req = { origin: "GDN", destination: "ATH", month: "2027-02" };
  const athens = { ...spain, depart_from: "2027-01-29", depart_to: "2027-02-14", max_transfers: 1, max_leg_minutes: 390 };
  const trips = ticketsToTrips(
    [
      ticket("2027-02-01", "2027-02-07", 900, { transfers: 1, return_transfers: 1, duration_to: 330, duration_back: 385 }), // ok
      ticket("2027-02-01", "2027-02-07", 700, { transfers: 1, duration_to: 480, duration_back: 200 }), // outbound too long
      ticket("2027-02-01", "2027-02-07", 650, { return_transfers: 1, duration_to: 200, duration_back: 420 }), // return too long
      ticket("2027-02-02", "2027-02-08", 600, { transfers: 1 }), // connection with unknown time: rejected
      ticket("2027-02-03", "2027-02-09", 800), // direct with unknown time: kept
    ],
    req,
    athens,
    "2026-09-25",
  );
  assert.deepEqual(trips.map((t) => t.price).sort(), [800, 900]);
  assert.equal(trips.find((t) => t.price === 900)!.duration_back, 385);
});

test("ticketsToTrips rejects returns after return_by", () => {
  const req = { origin: "GDN", destination: "ATH", month: "2027-02" };
  const athens = { ...spain, depart_from: "2027-01-29", depart_to: "2027-02-09", return_by: "2027-02-14", stay_min: 5, stay_max: 7 };
  const trips = ticketsToTrips(
    [
      ticket("2027-02-07", "2027-02-14", 500), // back on the last day: ok
      ticket("2027-02-09", "2027-02-15", 400), // back one day late
    ],
    req,
    athens,
    "2026-09-25",
  );
  assert.deepEqual(trips.map((t) => t.return_date), ["2027-02-14"]);
});

test("payingSeats counts adults and children aged 2+", () => {
  assert.equal(payingSeats({ ...spain, adults: 2, child_ages: [3, 7, 9] }), 5);
  assert.equal(payingSeats({ ...spain, adults: 2, child_ages: [1, 4] }), 3);
});

const trip = (destination: string, depart: string, price: number): Trip => ({
  origin: "GDN", destination, depart_date: depart, return_date: "2027-05-20", price, airline: null, transfers: 0,
  duration_to: null, duration_back: null, link: null,
});

test("cheapestPerTrip and cheapestPerRoute keep the lowest fare", () => {
  const trips = [trip("BCN", "2027-05-12", 500), trip("BCN", "2027-05-12", 450), trip("BCN", "2027-05-14", 390), trip("AGP", "2027-05-12", 600)];
  assert.equal(cheapestPerTrip(trips).length, 3);
  const routes = cheapestPerRoute(trips);
  assert.equal(routes.length, 2);
  assert.equal(routes.find((r) => r.destination === "BCN")!.price, 390);
});

test("median", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("evaluateRoute waits for a baseline", () => {
  assert.equal(evaluateRoute(100, [200, 200], 10, []).reason, "building-baseline");
});

test("evaluateRoute alerts on a drop at or above the threshold", () => {
  const r = evaluateRoute(450, [500, 510, 490, 700], 10, []);
  assert.equal(r.alert, true);
  assert.equal(r.baseline, 505);
  assert.equal(r.dropPct, 10.9);
});

test("evaluateRoute ignores small drops", () => {
  assert.equal(evaluateRoute(470, [500, 500, 500], 10, []).reason, "no-significant-drop");
});

test("evaluateRoute does not repeat an alert unless the price beats it", () => {
  assert.equal(evaluateRoute(440, [500, 500, 500], 10, [440]).reason, "already-alerted");
  assert.equal(evaluateRoute(420, [500, 500, 500], 10, [440]).alert, true);
});

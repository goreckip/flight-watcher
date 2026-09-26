// Daily job: fetch fares for every active watch, store them, email any significant price drops.
// Triggered by GitHub Actions (see .github/workflows/check-prices.yml).

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  addDays,
  buildSearchPlan,
  cheapestPerTrip,
  comboKey,
  countRejections,
  evaluateRoute,
  pickCombos,
  type TpTicket,
  type Trip,
  ticketsToTrips,
  tripCombos,
  type Watch,
} from "./logic.ts";
import { type AlertTrip, alertHtml, alertSubject, type PriceAlert } from "./email.ts";
import { fetchTickets } from "../_shared/travelpayouts.ts";
import { type GoogleFare, searchGoogleFlights } from "../_shared/serpapi.ts";
import { sendEmail } from "../_shared/resend.ts";

const HISTORY_DAYS = 14;
const ALERT_COOLDOWN_DAYS = 7;
const GOOGLE_FRESH_DAYS = 12; // matches route_daily_best
// ~100 free SerpApi searches/month → 3 per day across all watches, spread over 3 runs a day
const GOOGLE_DAILY_SEARCHES = Number(Deno.env.get("SERPAPI_DAILY_SEARCHES") ?? 3);
const GOOGLE_SEARCHES_PER_RUN = Number(Deno.env.get("SERPAPI_SEARCHES_PER_RUN") ?? 1);
const SNAPSHOT_KEY = "watch_id,checked_on,source,origin,destination,depart_date,return_date";

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
  // Every run is recorded so the dashboard can show when checks happened and what they found.
  const trigger = req.headers.get("x-trigger") === "manual" ? "manual" : "schedule";
  const { data: runRow } = await db.from("check_runs").insert({ trigger }).select("id").single();
  const finish = (fields: Record<string, unknown>) =>
    runRow ? db.from("check_runs").update({ finished_at: new Date().toISOString(), ...fields }).eq("id", runRow.id) : null;

  try {
    const summary = await run(db, runRow?.id ?? null);
    await finish({
      google_searches: summary.watches.reduce((n, w) => n + Number((w.google as { searches?: number })?.searches ?? 0), 0),
      fares: summary.watches.reduce((n, w) => n + Number(w.fares ?? 0), 0),
      alerts_sent: summary.alertsSent,
      errors: summary.errors,
    });
    return Response.json(summary);
  } catch (err) {
    console.error(err);
    const message = String((err as { message?: string }).message ?? err);
    await finish({ failed: message });
    return Response.json({ error: message }, { status: 500 });
  }
});

async function run(db: SupabaseClient, runId: number | null) {
  const today = new Date().toISOString().slice(0, 10);

  const { data: watches, error } = await db.from("watches").select("*").eq("active", true);
  if (error) throw error;

  const alerts: PriceAlert[] = [];
  const checked: Record<string, unknown>[] = [];
  const routes: Record<string, unknown>[] = [];
  const errors: string[] = [];

  // Google searches are shared across watches; searches already made today count against the budget.
  let googleLeft = 0;
  if (Deno.env.get("SERPAPI_KEY")) {
    const { count, error: countError } = await db.from("search_log")
      .select("id", { count: "exact", head: true })
      .eq("source", "google")
      .eq("checked_on", today);
    if (countError) throw countError;
    googleLeft = Math.min(GOOGLE_SEARCHES_PER_RUN, Math.max(0, GOOGLE_DAILY_SEARCHES - (count ?? 0)));
  }

  const list = watches ?? [];
  for (const [i, row] of list.entries()) {
    const watch: Watch = { ...row, drop_pct: Number(row.drop_pct) };
    const plan = buildSearchPlan(watch, today);

    let trips: Trip[] = [];
    const allTickets: TpTicket[] = [];
    for (const search of plan) {
      try {
        const tickets = await fetchTickets(search, {
          currency: watch.currency,
          directOnly: watch.max_transfers === 0,
        });
        allTickets.push(...tickets);
        trips.push(...ticketsToTrips(tickets, search, watch, today));
      } catch (err) {
        errors.push(`${watch.name} ${search.origin}-${search.destination} ${search.month}: ${err}`);
      }
    }
    trips = cheapestPerTrip(trips);
    await saveTravelpayouts(db, watch, trips, today);

    const googleBudget = Math.min(googleLeft, Math.ceil(googleLeft / (list.length - i)));
    const google = await googleSearches(db, watch, today, googleBudget);
    googleLeft -= google.searches;
    errors.push(...google.errors);

    // Time-stamped record of every fare this check saw (for "when are prices lowest?").
    await recordObservations(db, runId, watch, [
      ...trips.map((t) => ({ ...t, source: "travelpayouts", price_total: null })),
      ...google.found.map((f) => ({ ...f, source: "google" })),
    ]);

    checked.push({
      watch: watch.name,
      searches: plan.length,
      faresFromSource: allTickets.length,
      fares: trips.length + google.fares,
      rejected: countRejections(allTickets, watch, today),
      google: { searches: google.searches, fares: google.fares },
    });

    // Evaluate each route's best known fare today (both sources) against its recent history.
    const { data: todays, error: bestError } = await db.from("route_daily_best")
      .select("*").eq("watch_id", watch.id).eq("checked_on", today);
    if (bestError) throw bestError;

    // One chart point per route per check: the best known fare right now.
    if (todays?.length) {
      const { error: pointError } = await db.from("check_points").insert(todays.map((r) => ({
        run_id: runId, watch_id: watch.id, origin: r.origin, destination: r.destination,
        price: r.price, price_total: r.price_total, price_level: r.price_level, currency: r.currency,
        depart_date: r.depart_date, return_date: r.return_date, airline: r.airline, source: r.source,
      })));
      if (pointError) throw pointError;
    }

    for (const row of todays ?? []) {
      const best: AlertTrip = {
        origin: row.origin,
        destination: row.destination,
        depart_date: row.depart_date,
        return_date: row.return_date,
        price: Number(row.price),
        price_total: row.price_total == null ? null : Number(row.price_total),
        price_level: row.price_level,
        source: row.source,
        airline: row.airline,
        transfers: row.transfers,
        duration_to: row.duration_to,
        duration_back: row.duration_back,
        link: row.link,
      };
      const history = await routeHistory(db, watch.id, best, today);
      const recentAlerts = await recentAlertPrices(db, watch.id, best);
      const result = evaluateRoute(best.price, history, watch.drop_pct, recentAlerts);

      routes.push({
        watch: watch.name,
        route: `${best.origin}-${best.destination}`,
        price: best.price,
        source: best.source,
        dates: `${best.depart_date}..${best.return_date}`,
        historyDays: history.length,
        ...result,
      });
      if (result.alert) {
        alerts.push({ watch, trip: best, baseline: result.baseline!, dropPct: result.dropPct! });
      }
    }
  }

  if (alerts.length > 0) {
    await sendAlertEmail(alerts);
    // Recorded only after a successful send, so a failed email is retried next run.
    const { error: insertError } = await db.from("alerts").insert(
      alerts.map(({ watch, trip, baseline, dropPct }) => ({
        watch_id: watch.id,
        origin: trip.origin,
        destination: trip.destination,
        depart_date: trip.depart_date,
        return_date: trip.return_date,
        price: trip.price,
        baseline_price: baseline,
        drop_pct: dropPct,
        currency: watch.currency,
      })),
    );
    if (insertError) throw insertError;
  }

  return { date: today, watches: checked, alertsSent: alerts.length, routes, errors };
}


interface ObservedFare {
  source: string;
  origin: string;
  destination: string;
  depart_date: string;
  return_date: string;
  price: number;
  price_total: number | null;
}

async function recordObservations(db: SupabaseClient, runId: number | null, watch: Watch, fares: ObservedFare[]) {
  if (!fares.length) return;
  const { error } = await db.from("price_observations").insert(fares.map((f) => ({
    run_id: runId, watch_id: watch.id, source: f.source, origin: f.origin, destination: f.destination,
    depart_date: f.depart_date, return_date: f.return_date, price: f.price, price_total: f.price_total,
  })));
  if (error) throw error;
}

async function saveTravelpayouts(db: SupabaseClient, watch: Watch, trips: Trip[], today: string) {
  if (trips.length === 0) return;
  const { error } = await db.from("price_snapshots").upsert(
    trips.map((t) => ({
      ...t, watch_id: watch.id, checked_on: today, currency: watch.currency, source: "travelpayouts",
    })),
    { onConflict: SNAPSHOT_KEY },
  );
  if (error) throw error;
}

/**
 * Search up to `budget` exact date pairs on Google Flights, chosen by pickCombos, and store the
 * results. Every search is logged (even empty or failed ones) to drive the rotation and quota.
 */
async function googleSearches(db: SupabaseClient, watch: Watch, today: string, budget: number) {
  const out = { searches: 0, fares: 0, errors: [] as string[], found: [] as GoogleFare[] };
  const combos = tripCombos(watch, today);
  if (budget <= 0 || combos.length === 0) return out;

  const { data: log, error: logError } = await db.from("search_log")
    .select("depart_date, return_date, checked_on")
    .eq("watch_id", watch.id).eq("source", "google")
    .gte("checked_on", addDays(today, -90));
  if (logError) throw logError;
  const lastChecked = new Map<string, string>();
  for (const r of log ?? []) {
    const key = comboKey({ depart: r.depart_date, ret: r.return_date });
    if ((lastChecked.get(key) ?? "") < r.checked_on) lastChecked.set(key, r.checked_on);
  }

  const { data: cheapest, error: cheapestError } = await db.from("price_snapshots")
    .select("depart_date, return_date")
    .eq("watch_id", watch.id).eq("source", "google")
    .gt("checked_on", addDays(today, -GOOGLE_FRESH_DAYS))
    .order("price").limit(1);
  if (cheapestError) throw cheapestError;
  const cheapestKey = cheapest?.[0] ? comboKey({ depart: cheapest[0].depart_date, ret: cheapest[0].return_date }) : null;

  for (const combo of pickCombos(combos, lastChecked, cheapestKey, today, budget)) {
    out.searches++;
    let results = 0;
    let errorText: string | null = null;
    try {
      const fares = await searchGoogleFlights(watch, combo);
      results = fares.length;
      out.fares += fares.length;
      out.found.push(...fares);
      if (fares.length) {
        const { error } = await db.from("price_snapshots").upsert(
          fares.map((f) => ({ ...f, watch_id: watch.id, checked_on: today, currency: watch.currency, source: "google" })),
          { onConflict: SNAPSHOT_KEY },
        );
        if (error) throw error;
      }
    } catch (err) {
      errorText = String((err as { message?: string }).message ?? err);
      out.errors.push(`${watch.name} Google ${combo.depart}..${combo.ret}: ${errorText}`);
    }
    const { error } = await db.from("search_log").insert({
      watch_id: watch.id, source: "google", checked_on: today,
      depart_date: combo.depart, return_date: combo.ret, results, error: errorText,
    });
    if (error) throw error;
  }
  return out;
}

/** Best known fare for this route on each of the previous HISTORY_DAYS days (today excluded). */
async function routeHistory(db: SupabaseClient, watchId: number, trip: Trip, today: string) {
  const { data, error } = await db
    .from("route_daily_best")
    .select("price")
    .eq("watch_id", watchId)
    .eq("origin", trip.origin)
    .eq("destination", trip.destination)
    .gte("checked_on", addDays(today, -HISTORY_DAYS))
    .lt("checked_on", today);
  if (error) throw error;
  return (data ?? []).map((r) => Number(r.price));
}

async function recentAlertPrices(db: SupabaseClient, watchId: number, trip: Trip) {
  const since = new Date(Date.now() - ALERT_COOLDOWN_DAYS * 86_400_000).toISOString();
  const { data, error } = await db
    .from("alerts")
    .select("price")
    .eq("watch_id", watchId)
    .eq("origin", trip.origin)
    .eq("destination", trip.destination)
    .gte("sent_at", since);
  if (error) throw error;
  return (data ?? []).map((r) => Number(r.price));
}

async function sendAlertEmail(alerts: PriceAlert[]) {
  await sendEmail(alertSubject(alerts), alertHtml(alerts));
}

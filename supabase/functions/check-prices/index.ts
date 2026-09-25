// Daily job: fetch fares for every active watch, store them, email any significant price drops.
// Triggered by GitHub Actions (see .github/workflows/check-prices.yml).

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  addDays,
  buildSearchPlan,
  cheapestPerRoute,
  cheapestPerTrip,
  countRejections,
  evaluateRoute,
  type TpTicket,
  type Trip,
  ticketsToTrips,
  type Watch,
} from "./logic.ts";
import { alertHtml, alertSubject, type PriceAlert } from "./email.ts";
import { fetchTickets } from "../_shared/travelpayouts.ts";

const HISTORY_DAYS = 14;
const ALERT_COOLDOWN_DAYS = 7;

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

  try {
    const summary = await run();
    return Response.json(summary);
  } catch (err) {
    console.error(err);
    return Response.json({ error: String(err) }, { status: 500 });
  }
});

async function run() {
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
  const today = new Date().toISOString().slice(0, 10);

  const { data: watches, error } = await db.from("watches").select("*").eq("active", true);
  if (error) throw error;

  const alerts: PriceAlert[] = [];
  const checked: Record<string, unknown>[] = [];
  const routes: Record<string, unknown>[] = [];
  const errors: string[] = [];

  for (const row of watches ?? []) {
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
    await saveSnapshots(db, watch, trips, today);
    checked.push({
      watch: watch.name,
      searches: plan.length,
      faresFromSource: allTickets.length,
      fares: trips.length,
      rejected: countRejections(allTickets, watch, today),
    });

    for (const best of cheapestPerRoute(trips)) {
      const history = await routeHistory(db, watch.id, best, today);
      const recentAlerts = await recentAlertPrices(db, watch.id, best);
      const result = evaluateRoute(best.price, history, watch.drop_pct, recentAlerts);

      routes.push({
        watch: watch.name,
        route: `${best.origin}-${best.destination}`,
        price: best.price,
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
    await sendEmail(alerts);
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


async function saveSnapshots(db: SupabaseClient, watch: Watch, trips: Trip[], today: string) {
  if (trips.length === 0) return;
  const { error } = await db.from("price_snapshots").upsert(
    trips.map((t) => ({ ...t, watch_id: watch.id, checked_on: today, currency: watch.currency })),
    { onConflict: "watch_id,checked_on,origin,destination,depart_date,return_date" },
  );
  if (error) throw error;
}

/** Daily cheapest fares for this route over the previous HISTORY_DAYS days (today excluded). */
async function routeHistory(db: SupabaseClient, watchId: number, trip: Trip, today: string) {
  const { data, error } = await db
    .from("route_daily_min")
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

async function sendEmail(alerts: PriceAlert[]) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("RESEND_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: Deno.env.get("ALERT_EMAIL_FROM") ?? "Flight Watcher <onboarding@resend.dev>",
      to: env("ALERT_EMAIL_TO").split(",").map((s) => s.trim()),
      subject: alertSubject(alerts),
      html: alertHtml(alerts),
    }),
  });
  if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${await res.text()}`);
}

// HTTP API for the web dashboard (web/). Protected by one shared password: APP_PASSWORD.
//
//   GET    /auth               check the password
//   GET    /overview           watches + last 60 days of daily cheapest fares + recent alerts
//   POST   /watches            create a watch
//   PATCH  /watches/:id        update a watch
//   DELETE /watches/:id        delete a watch and its history
//   GET    /watches/:id/trips  latest known fare per date pair (both sources)
//   GET    /watches/:id/diagnose  live search showing how many fares each rule drops
//   POST   /watches/:id/google-test  one Google search for chosen dates, with a full report (uses 1 search)
//   POST   /check              run check-prices now
//   POST   /test-email         send a sample alert (built from a real current fare) to ALERT_EMAIL_TO
//   POST   /digest             send the weekly summary email now

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  addDays,
  buildSearchPlan,
  countRejections,
  ticketsToTrips,
  type TpTicket,
  type Watch,
} from "../check-prices/logic.ts";
import { fetchTickets } from "../_shared/travelpayouts.ts";
import { googleSearchReport, serpApiAccount } from "../_shared/serpapi.ts";
import { sendEmail } from "../_shared/resend.ts";
import { alertHtml, alertSubject, type PriceAlert } from "../check-prices/email.ts";
import { GOOGLE_FRESH_DAYS, googleCoverage, latestFares, toWatch } from "../_shared/queries.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-app-password",
};

const WATCH_FIELDS = [
  "name", "origins", "destinations", "depart_from", "depart_to", "return_by",
  "stay_min", "stay_max", "max_transfers", "max_leg_minutes",
  "adults", "child_ages", "drop_pct", "currency", "active",
];

const HISTORY_DAYS = 60;

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** Constant-time comparison so response timing doesn't leak the password. */
function passwordOk(given: string | null): boolean {
  const expected = Deno.env.get("APP_PASSWORD");
  if (!expected || !given) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function pickWatchFields(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of WATCH_FIELDS) if (key in body) out[key] = body[key];
  for (const key of ["origins", "destinations"]) {
    if (Array.isArray(out[key])) {
      out[key] = (out[key] as unknown[]).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
    }
  }
  if (typeof out.currency === "string") out.currency = out.currency.toUpperCase();
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (!passwordOk(req.headers.get("x-app-password"))) return json({ error: "Wrong password" }, 401);

  const path = new URL(req.url).pathname.replace(/^.*?\/api(?=\/|$)/, "") || "/";
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });

  try {
    if (req.method === "GET" && path === "/auth") return json({ ok: true });
    if (req.method === "GET" && path === "/overview") return json(await overview(db));
    if (req.method === "POST" && path === "/check") return await runCheck();
    if (req.method === "POST" && path === "/test-email") return json(await testEmail(db));
    if (req.method === "POST" && path === "/digest") return await callInternal("weekly-digest");

    if (req.method === "POST" && path === "/watches") {
      const { data, error } = await db.from("watches").insert(pickWatchFields(await req.json()))
        .select().single();
      if (error) throw error;
      return json(data, 201);
    }

    const match = path.match(/^\/watches\/(\d+)(\/trips|\/diagnose|\/google-test)?$/);
    if (match) {
      const id = Number(match[1]);
      if (match[2] === "/google-test" && req.method === "POST") return json(await googleTest(db, id, await req.json()));
      if (match[2] === "/trips" && req.method === "GET") return json(await latestTrips(db, id));
      if (match[2] === "/diagnose" && req.method === "GET") return json(await diagnose(db, id));
      if (!match[2] && req.method === "PATCH") {
        const { data, error } = await db.from("watches").update(pickWatchFields(await req.json()))
          .eq("id", id).select().single();
        if (error) throw error;
        return json(data);
      }
      if (!match[2] && req.method === "DELETE") {
        const { error } = await db.from("watches").delete().eq("id", id);
        if (error) throw error;
        return json({ ok: true });
      }
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    console.error(err);
    const message = (err as { message?: string }).message ?? String(err);
    return json({ error: message }, 400);
  }
});

async function overview(db: SupabaseClient) {
  const today = new Date().toISOString().slice(0, 10);
  const since = addDays(today, -HISTORY_DAYS);
  const [watches, daily, alerts, account, runs, googleToday] = await Promise.all([
    db.from("watches").select("*").order("created_at"),
    db.from("route_daily_best")
      .select("watch_id, origin, destination, checked_on, price, price_total, price_level, currency, depart_date, return_date, airline, source")
      .gte("checked_on", since)
      .order("checked_on"),
    db.from("alerts").select("*").order("sent_at", { ascending: false }).limit(20),
    serpApiAccount().catch(() => null),
    db.from("check_runs").select("*").order("started_at", { ascending: false }).limit(10),
    db.from("search_log").select("id", { count: "exact", head: true })
      .eq("source", "google").eq("checked_on", today),
  ]);
  for (const result of [watches, daily, alerts, runs, googleToday]) if (result.error) throw result.error;
  const coverage = await googleCoverage(db, (watches.data ?? []).map(toWatch));

  return {
    watches: watches.data,
    daily: daily.data,
    alerts: alerts.data,
    runs: runs.data,
    google: {
      enabled: Boolean(Deno.env.get("SERPAPI_KEY")),
      account,
      coverage,
      freshDays: GOOGLE_FRESH_DAYS,
      searchesToday: googleToday.count ?? 0,
      dailyLimit: Number(Deno.env.get("SERPAPI_DAILY_SEARCHES") ?? 3),
    },
  };
}

const latestTrips = (db: SupabaseClient, watchId: number) => latestFares(db, watchId, 30);

/**
 * Run the watch's searches live (nothing is saved) and report, per search:
 * how many round-trip fares the source returned, how many each rule rejected,
 * and, as a baseline, how many one-way outbound fares exist on the route at all.
 */
async function diagnose(db: SupabaseClient, watchId: number) {
  const { data: row, error } = await db.from("watches").select("*").eq("id", watchId).single();
  if (error) throw error;
  const watch: Watch = { ...row, drop_pct: Number(row.drop_pct) };
  const today = new Date().toISOString().slice(0, 10);
  const sample = (t: TpTicket) => ({
    price: t.price, airline: t.airline, departure_at: t.departure_at, return_at: t.return_at,
    transfers: t.transfers, return_transfers: t.return_transfers,
    duration_to: t.duration_to, duration_back: t.duration_back,
  });

  const searches = [];
  for (const search of buildSearchPlan(watch, today)) {
    const result: Record<string, unknown> = { ...search };
    try {
      const roundTrip = await fetchTickets(search, { currency: watch.currency, directOnly: watch.max_transfers === 0 });
      result.roundTrip = {
        fares: roundTrip.length,
        matching: ticketsToTrips(roundTrip, search, watch, today).length,
        rejected: countRejections(roundTrip, watch, today),
        cheapest: roundTrip.slice(0, 5).map(sample),
      };
      const oneWay = await fetchTickets(search, { currency: watch.currency, directOnly: false, oneWay: true });
      result.oneWayOutbound = { fares: oneWay.length, cheapest: oneWay.slice(0, 3).map(sample) };
    } catch (err) {
      result.error = String(err);
    }
    searches.push(result);
  }

  // Probes to tell "no data for this route" apart from "API/market problem".
  const nextMonth = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 7);
  const origin = watch.origins[0];
  const destination = watch.destinations[0];
  const probeDefs: { label: string; origin: string; destination: string; month: string; market?: string }[] = [
    { label: `Sanity: WAW→LON ${nextMonth}, one-way`, origin: "WAW", destination: "LON", month: nextMonth },
    { label: `${origin}→${destination} any date, one-way`, origin, destination, month: "" },
    { label: `${origin}→${destination} ${nextMonth}, one-way`, origin, destination, month: nextMonth },
    ...["pl", "us", "gb", "de"].map((market) => ({
      label: `${origin}→${destination} any date, one-way, market=${market}`, origin, destination, month: "", market,
    })),
  ];
  const probes = [];
  for (const p of probeDefs) {
    try {
      const tickets = await fetchTickets(
        { origin: p.origin, destination: p.destination, month: p.month },
        { currency: watch.currency, directOnly: false, oneWay: true, market: p.market },
      );
      probes.push({ label: p.label, fares: tickets.length, cheapest: tickets.slice(0, 2).map(sample) });
    } catch (err) {
      probes.push({ label: p.label, error: String(err) });
    }
  }

  const { data: googleLog, error: logError } = await db.from("search_log")
    .select("checked_on, depart_date, return_date, results, error")
    .eq("watch_id", watchId).eq("source", "google")
    .order("created_at", { ascending: false }).limit(30);
  if (logError) throw logError;

  return { today, watch: watch.name, searches, probes, googleLog };
}

/** One Google search for dates the user picks; logged and saved like a scheduled search. */
async function googleTest(db: SupabaseClient, watchId: number, body: { depart?: string; ret?: string; filters?: boolean }) {
  const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isDate(body.depart) || !isDate(body.ret) || body.ret! <= body.depart!) {
    throw new Error("Pick a departure date and a later return date.");
  }
  const { data: row, error } = await db.from("watches").select("*").eq("id", watchId).single();
  if (error) throw error;
  const watch: Watch = { ...row, drop_pct: Number(row.drop_pct) };
  const combo = { depart: body.depart!, ret: body.ret! };
  const today = new Date().toISOString().slice(0, 10);

  const report = await googleSearchReport(watch, combo, body.filters !== false);

  if (report.fares.length) {
    const { error: saveError } = await db.from("price_snapshots").upsert(
      report.fares.map((f) => ({ ...f, watch_id: watch.id, checked_on: today, currency: watch.currency, source: "google" })),
      { onConflict: "watch_id,checked_on,source,origin,destination,depart_date,return_date" },
    );
    if (saveError) throw saveError;
  }
  const { error: logError } = await db.from("search_log").insert({
    watch_id: watch.id, source: "google", checked_on: today,
    depart_date: combo.depart, return_date: combo.ret, results: report.fares.length, error: report.error,
  });
  if (logError) throw logError;
  return report;
}

/** Sample alert using the most recent best fare, so the email looks exactly like a real one. */
async function testEmail(db: SupabaseClient) {
  const { data: best, error } = await db.from("route_daily_best")
    .select("*").order("checked_on", { ascending: false }).order("price").limit(1);
  if (error) throw error;
  if (!best?.length) throw new Error("No fares recorded yet. Run a price check first.");
  const row = best[0];

  const { data: w, error: watchError } = await db.from("watches").select("*").eq("id", row.watch_id).single();
  if (watchError) throw watchError;
  const watch: Watch = { ...w, drop_pct: Number(w.drop_pct) };

  const price = Number(row.price);
  const alert: PriceAlert = {
    watch,
    trip: {
      origin: row.origin, destination: row.destination,
      depart_date: row.depart_date, return_date: row.return_date,
      price,
      price_total: row.price_total == null ? null : Number(row.price_total),
      price_level: row.price_level, source: row.source,
      airline: row.airline, transfers: row.transfers,
      duration_to: row.duration_to, duration_back: row.duration_back, link: row.link,
    },
    baseline: Math.round(price / 0.88), // pretend it fell 12%
    dropPct: 12,
  };
  const note = `<p style="background:#fff7d6;padding:8px 12px;border-radius:6px;font-family:system-ui,sans-serif;font-size:14px">
    <b>Test email.</b> The fare below is real, but the drop is made up to show what an alert looks like.</p>`;
  const sent = await sendEmail(`[TEST] ${alertSubject([alert])}`, note + alertHtml([alert]));
  return { ok: true, to: sent.to, id: sent.id };
}

const runCheck = () => callInternal("check-prices");

/** Call another of our functions with the cron secret and pass its JSON response through. */
async function callInternal(fn: "check-prices" | "weekly-digest"): Promise<Response> {
  const res = await fetch(`${env("SUPABASE_URL")}/functions/v1/${fn}`, {
    method: "POST",
    headers: { "x-cron-secret": env("CRON_SECRET"), "x-trigger": "manual" },
  });
  const body = await res.json().catch(() => ({ error: `${fn} HTTP ${res.status}` }));
  return json(body, res.status);
}

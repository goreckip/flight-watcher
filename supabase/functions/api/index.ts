// HTTP API for the web dashboard (web/). Protected by one shared password: APP_PASSWORD.
//
//   GET    /auth               check the password
//   GET    /overview           watches + last 60 days of daily cheapest fares + recent alerts
//   POST   /watches            create a watch
//   PATCH  /watches/:id        update a watch
//   DELETE /watches/:id        delete a watch and its history
//   GET    /watches/:id/trips  latest known fare per date pair (both sources)
//   GET    /watches/:id/diagnose  live search showing how many fares each rule drops
//   POST   /check              run check-prices now

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  addDays,
  buildSearchPlan,
  comboKey,
  countRejections,
  ticketsToTrips,
  type TpTicket,
  tripCombos,
  type Watch,
} from "../check-prices/logic.ts";
import { fetchTickets } from "../_shared/travelpayouts.ts";
import { serpApiAccount } from "../_shared/serpapi.ts";

const GOOGLE_FRESH_DAYS = 12; // matches route_daily_best

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

    if (req.method === "POST" && path === "/watches") {
      const { data, error } = await db.from("watches").insert(pickWatchFields(await req.json()))
        .select().single();
      if (error) throw error;
      return json(data, 201);
    }

    const match = path.match(/^\/watches\/(\d+)(\/trips|\/diagnose)?$/);
    if (match) {
      const id = Number(match[1]);
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
  const [watches, daily, alerts, log, account] = await Promise.all([
    db.from("watches").select("*").order("created_at"),
    db.from("route_daily_best")
      .select("watch_id, origin, destination, checked_on, price, price_total, price_level, currency, depart_date, return_date, airline, source")
      .gte("checked_on", since)
      .order("checked_on"),
    db.from("alerts").select("*").order("sent_at", { ascending: false }).limit(20),
    db.from("search_log").select("watch_id, depart_date, return_date")
      .eq("source", "google").gt("checked_on", addDays(today, -GOOGLE_FRESH_DAYS)),
    serpApiAccount().catch(() => null),
  ]);
  for (const result of [watches, daily, alerts, log]) if (result.error) throw result.error;

  // How many of each watch's date pairs Google has looked at recently.
  const googleCoverage: Record<number, { checked: number; total: number }> = {};
  for (const row of watches.data ?? []) {
    const watch: Watch = { ...row, drop_pct: Number(row.drop_pct) };
    const keys = new Set(tripCombos(watch, today).map(comboKey));
    const checked = new Set(
      (log.data ?? []).filter((r) => r.watch_id === watch.id)
        .map((r) => comboKey({ depart: r.depart_date, ret: r.return_date }))
        .filter((k) => keys.has(k)),
    );
    googleCoverage[watch.id] = { checked: checked.size, total: keys.size };
  }

  return {
    watches: watches.data,
    daily: daily.data,
    alerts: alerts.data,
    google: { enabled: Boolean(Deno.env.get("SERPAPI_KEY")), account, coverage: googleCoverage, freshDays: GOOGLE_FRESH_DAYS },
  };
}

/** Latest known fare for each date pair: today's Aviasales fares plus Google fares from the last 12 days. */
async function latestTrips(db: SupabaseClient, watchId: number) {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await db.from("price_snapshots")
    .select("*")
    .eq("watch_id", watchId)
    .gt("checked_on", addDays(today, -GOOGLE_FRESH_DAYS))
    .order("checked_on", { ascending: false })
    .limit(2000);
  if (error) throw error;
  if (!data?.length) return { checked_on: null, trips: [] };

  const latestTp = data.find((r) => r.source === "travelpayouts")?.checked_on;
  const seen = new Set<string>();
  const trips = data.filter((r) => {
    if (r.source === "travelpayouts" && r.checked_on !== latestTp) return false;
    const key = `${r.source}|${r.origin}|${r.destination}|${r.depart_date}|${r.return_date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => Number(a.price) - Number(b.price)).slice(0, 30);
  return { checked_on: data[0].checked_on, trips };
}

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

  return { today, watch: watch.name, searches, probes };
}

async function runCheck(): Promise<Response> {
  const res = await fetch(`${env("SUPABASE_URL")}/functions/v1/check-prices`, {
    method: "POST",
    headers: { "x-cron-secret": env("CRON_SECRET") },
  });
  const body = await res.json().catch(() => ({ error: `check-prices HTTP ${res.status}` }));
  return json(body, res.status);
}

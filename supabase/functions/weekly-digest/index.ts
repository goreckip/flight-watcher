// Weekly summary email for all active watches.
// Triggered by GitHub Actions on Sunday evening (see .github/workflows/weekly-digest.yml),
// or on demand from the dashboard via the api function.

import { createClient } from "npm:@supabase/supabase-js@2";
import { addDays } from "../check-prices/logic.ts";
import { type DailyBest, digestHtml, digestSubject, type FareRow, type WatchDigest, weeklyStats } from "../_shared/digest.ts";
import { googleCoverage, latestFares, toWatch, today } from "../_shared/queries.ts";
import { serpApiAccount } from "../_shared/serpapi.ts";
import { sendEmail } from "../_shared/resend.ts";

const DASHBOARD_URL = Deno.env.get("DASHBOARD_URL") ?? "https://goreckip.github.io/flight-watcher/";

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
    return Response.json(await run());
  } catch (err) {
    console.error(err);
    return Response.json({ error: String((err as { message?: string }).message ?? err) }, { status: 500 });
  }
});

async function run() {
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
  const t = today();

  const { data: rows, error } = await db.from("watches").select("*").eq("active", true).order("created_at");
  if (error) throw error;
  const watches = (rows ?? []).map(toWatch);
  const ids = watches.map((w) => w.id);

  const [daily, alerts, coverage, account] = await Promise.all([
    ids.length
      ? db.from("route_daily_best").select("*").in("watch_id", ids).gte("checked_on", addDays(t, -14))
      : Promise.resolve({ data: [], error: null }),
    ids.length
      ? db.from("alerts").select("watch_id").in("watch_id", ids)
        .gte("sent_at", new Date(Date.now() - 7 * 86_400_000).toISOString())
      : Promise.resolve({ data: [], error: null }),
    googleCoverage(db, watches),
    serpApiAccount().catch(() => null),
  ]);
  if (daily.error) throw daily.error;
  if (alerts.error) throw alerts.error;

  const items: WatchDigest[] = [];
  for (const watch of watches) {
    const watchRows = ((daily.data ?? []) as DailyBest[])
      .filter((r) => r.watch_id === watch.id)
      .map((r) => ({ ...r, price: Number(r.price), price_total: r.price_total == null ? null : Number(r.price_total) }));
    const { trips } = await latestFares(db, watch.id, 5);
    items.push({
      watch,
      stats: weeklyStats(watchRows, t),
      topFares: trips as unknown as FareRow[],
      coverage: coverage[watch.id] ?? null,
      alertsThisWeek: (alerts.data ?? []).filter((a) => a.watch_id === watch.id).length,
    });
  }

  const sent = await sendEmail(
    digestSubject(items),
    digestHtml(items, { dashboardUrl: DASHBOARD_URL, searchesLeft: account?.searchesLeft ?? null }),
  );
  return { sent: true, to: sent.to, watches: items.length };
}

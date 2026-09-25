// Database reads shared by the api and weekly-digest functions.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { addDays, comboKey, tripCombos, type Watch } from "../check-prices/logic.ts";

export const GOOGLE_FRESH_DAYS = 12; // matches route_daily_best

export const today = () => new Date().toISOString().slice(0, 10);

export function toWatch(row: Record<string, unknown>): Watch {
  return { ...row, drop_pct: Number(row.drop_pct) } as Watch;
}

/**
 * Latest known fare per date option, cheapest first: the most recent Aviasales check plus
 * Google fares from the last GOOGLE_FRESH_DAYS days.
 */
export async function latestFares(db: SupabaseClient, watchId: number, limit = 30) {
  const { data, error } = await db.from("price_snapshots")
    .select("*")
    .eq("watch_id", watchId)
    .gt("checked_on", addDays(today(), -GOOGLE_FRESH_DAYS))
    .order("checked_on", { ascending: false })
    .limit(2000);
  if (error) throw error;
  if (!data?.length) return { checked_on: null as string | null, trips: [] as Record<string, unknown>[] };

  const latestTp = data.find((r) => r.source === "travelpayouts")?.checked_on;
  const seen = new Set<string>();
  const trips = data.filter((r) => {
    if (r.source === "travelpayouts" && r.checked_on !== latestTp) return false;
    const key = `${r.source}|${r.origin}|${r.destination}|${r.depart_date}|${r.return_date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => Number(a.price) - Number(b.price)).slice(0, limit);
  return { checked_on: data[0].checked_on as string, trips };
}

/** How many of each watch's date options Google has searched in the last GOOGLE_FRESH_DAYS days. */
export async function googleCoverage(db: SupabaseClient, watches: Watch[]) {
  const t = today();
  const { data: log, error } = await db.from("search_log")
    .select("watch_id, depart_date, return_date")
    .eq("source", "google").gt("checked_on", addDays(t, -GOOGLE_FRESH_DAYS));
  if (error) throw error;

  const coverage: Record<number, { checked: number; total: number }> = {};
  for (const watch of watches) {
    const keys = new Set(tripCombos(watch, t).map(comboKey));
    const checked = new Set(
      (log ?? []).filter((r) => r.watch_id === watch.id)
        .map((r) => comboKey({ depart: r.depart_date, ret: r.return_date }))
        .filter((k) => keys.has(k)),
    );
    coverage[watch.id] = { checked: checked.size, total: keys.size };
  }
  return coverage;
}

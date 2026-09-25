// Weekly summary email: pure stats + HTML, no I/O (unit-tested under Node).
import { addDays, payingSeats, type Watch } from "../check-prices/logic.ts";

/** One row of route_daily_best (best known fare for a route on a day). */
export interface DailyBest {
  watch_id: number;
  origin: string;
  destination: string;
  checked_on: string;
  price: number;
  price_total: number | null;
  price_level: string | null;
  depart_date: string;
  return_date: string;
  airline: string | null;
  source: string;
}

/** A latest-known fare for one date option (price_snapshots row). */
export interface FareRow {
  origin: string;
  destination: string;
  depart_date: string;
  return_date: string;
  price: number;
  price_total: number | null;
  airline: string | null;
  transfers: number;
  duration_to: number | null;
  source: string;
  checked_on: string;
  link: string | null;
}

export interface WeeklyStats {
  best: DailyBest;
  weekAgo: DailyBest | null;
  changePct: number | null;
  low: number;
  high: number;
  series: (number | null)[]; // last 7 days, oldest first
}

/** Best fare per day across routes, then this week's picture. Null when there's no data yet. */
export function weeklyStats(rows: DailyBest[], today: string): WeeklyStats | null {
  const byDay = new Map<string, DailyBest>();
  for (const r of rows) {
    if (r.checked_on > today) continue;
    const cur = byDay.get(r.checked_on);
    if (!cur || Number(r.price) < Number(cur.price)) byDay.set(r.checked_on, r);
  }
  const days = [...byDay.keys()].sort();
  if (!days.length) return null;

  const best = byDay.get(days.at(-1)!)!;
  const weekAgoDay = [...days].reverse().find((d) => d <= addDays(today, -7));
  const weekAgo = weekAgoDay ? byDay.get(weekAgoDay)! : null;
  const changePct = weekAgo
    ? Math.round(((Number(best.price) - Number(weekAgo.price)) / Number(weekAgo.price)) * 1000) / 10
    : null;

  const series: (number | null)[] = [];
  for (let i = 6; i >= 0; i--) {
    const r = byDay.get(addDays(today, -i));
    series.push(r ? Number(r.price) : null);
  }
  const values = series.filter((v): v is number => v !== null);
  const low = values.length ? Math.min(...values) : Number(best.price);
  const high = values.length ? Math.max(...values) : Number(best.price);
  return { best, weekAgo, changePct, low, high, series };
}

const BARS = "▁▂▃▄▅▆▇█";

/** Text sparkline that works in any email client; gaps shown as a middle dot. */
export function sparkline(values: (number | null)[]): string {
  const nums = values.filter((v): v is number => v !== null);
  if (!nums.length) return "";
  const min = Math.min(...nums);
  const span = Math.max(...nums) - min;
  return values.map((v) =>
    v === null ? "·" : BARS[span === 0 ? 3 : Math.round(((v - min) / span) * (BARS.length - 1))]
  ).join("");
}

// ---------- HTML ----------

export interface WatchDigest {
  watch: Watch;
  stats: WeeklyStats | null;
  topFares: FareRow[];
  coverage: { checked: number; total: number } | null;
  alertsThisWeek: number;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const money = (n: number, cur: string) => `${Math.round(n).toLocaleString("pl-PL")} ${cur}`;
const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const short = (iso: string) => dateFmt.format(new Date(iso));
const nights = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const hours = (m: number | null) => (m ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : "?");
const sourceName = (s: string) => (s === "google" ? "Google Flights" : "Aviasales cache");

function groupTotal(fare: { price: number; price_total: number | null }, watch: Watch) {
  if (fare.price_total) return { amount: Number(fare.price_total), exact: true };
  return { amount: Number(fare.price) * payingSeats(watch), exact: false };
}

function changeText(pct: number | null): string {
  if (pct === null) return "not enough history yet";
  if (Math.abs(pct) < 0.5) return "● unchanged vs 7 days ago";
  return pct < 0
    ? `<span style="color:#15803d">▼ ${Math.abs(pct)}% vs 7 days ago</span>`
    : `<span style="color:#b42323">▲ ${pct}% vs 7 days ago</span>`;
}

export function digestSubject(items: WatchDigest[]): string {
  const withData = items.filter((i) => i.stats);
  if (items.length === 1 && withData.length === 1) {
    const { watch, stats } = withData[0];
    const total = groupTotal(stats!.best, watch);
    const seats = payingSeats(watch);
    const price = seats > 1 ? `${total.exact ? "" : "~"}${money(total.amount, watch.currency)} for ${seats}`
      : money(Number(stats!.best.price), watch.currency);
    const change = stats!.changePct === null ? "" : ` (${stats!.changePct <= 0 ? "▼" : "▲"}${Math.abs(stats!.changePct)}%)`;
    return `Weekly flight summary: ${watch.name} ${price}${change}`;
  }
  return `Weekly flight summary: ${items.length} watches`;
}

function watchBlock(d: WatchDigest): string {
  const { watch, stats } = d;
  const cur = watch.currency;
  const seats = payingSeats(watch);
  const criteria = [
    `${watch.origins.join(", ")} → ${watch.destinations.join(", ")}`,
    `${short(watch.depart_from)} – ${short(watch.return_by ?? addDays(watch.depart_to, watch.stay_max))}`,
    `${watch.stay_min}–${watch.stay_max} nights`,
    watch.max_transfers === 0 ? "direct only" : `≤ ${watch.max_transfers} stop${watch.max_transfers === 1 ? "" : "s"}`,
  ].map(esc).join(" · ");

  if (!stats) {
    return `<h2 style="font-size:18px;margin:24px 0 4px">${esc(watch.name)}</h2>
      <p style="color:#555;margin:0 0 8px">${criteria}</p>
      <p>No fares recorded yet.</p>`;
  }

  const b = stats.best;
  const total = groupTotal(b, watch);
  const fares = d.topFares.map((f) => {
    const t = groupTotal(f, watch);
    return `<tr>
      <td>${short(f.depart_date)} – ${short(f.return_date)} <span style="color:#777">(${nights(f.depart_date, f.return_date)} n)</span></td>
      <td>${esc(f.airline ?? "")}</td>
      <td>${f.transfers ? `${f.transfers} stop` : "direct"} · ${hours(f.duration_to)}</td>
      <td style="text-align:right"><b>${money(Number(f.price), cur)}</b></td>
      ${seats > 1 ? `<td style="text-align:right">${t.exact ? "" : "~"}${money(t.amount, cur)}</td>` : ""}
      <td style="color:#777">${esc(sourceName(f.source))}, ${short(f.checked_on)}</td>
    </tr>`;
  }).join("");

  return `<h2 style="font-size:18px;margin:24px 0 4px">${esc(watch.name)}</h2>
  <p style="color:#555;margin:0 0 12px">${criteria}</p>
  <table cellpadding="6" style="border-collapse:collapse;margin-bottom:12px">
    <tr><td style="color:#555">Cheapest now</td>
      <td><b style="font-size:18px">${money(Number(b.price), cur)}</b> / person${seats > 1 ? ` · <b>${total.exact ? "" : "~"}${money(total.amount, cur)}</b> for ${seats}` : ""}
        <br><span style="color:#555">${short(b.depart_date)} – ${short(b.return_date)} · ${esc(b.origin)} → ${esc(b.destination)}${b.airline ? ` · ${esc(b.airline)}` : ""} · ${esc(sourceName(b.source))}</span></td></tr>
    <tr><td style="color:#555">This week</td>
      <td>${changeText(stats.changePct)} · range ${money(stats.low, cur)}–${money(stats.high, cur)}
        <br><span style="font-family:monospace;font-size:16px;letter-spacing:2px">${sparkline(stats.series)}</span>
        <span style="color:#777;font-size:12px"> last 7 days</span></td></tr>
    ${b.price_level ? `<tr><td style="color:#555">Google says</td><td>prices are <b>${esc(b.price_level)}</b> for this route</td></tr>` : ""}
    ${d.alertsThisWeek ? `<tr><td style="color:#555">Alerts</td><td>${d.alertsThisWeek} price-drop alert${d.alertsThisWeek === 1 ? "" : "s"} this week</td></tr>` : ""}
  </table>
  ${fares ? `<p style="margin:0 0 4px;color:#555">Cheapest date options</p>
  <table cellpadding="6" style="border-collapse:collapse;border:1px solid #e5e5e5;font-size:13px">
    <thead style="background:#f5f5f5;text-align:left"><tr><th>Dates</th><th>Airline</th><th>Stops · out</th>
      <th style="text-align:right">Per person</th>${seats > 1 ? `<th style="text-align:right">${seats} seats</th>` : ""}<th>Source</th></tr></thead>
    <tbody>${fares}</tbody>
  </table>` : ""}
  ${d.coverage?.total ? `<p style="color:#777;font-size:12px;margin:6px 0 0">Google Flights has checked ${d.coverage.checked} of ${d.coverage.total} date options in the last 12 days.</p>` : ""}`;
}

export function digestHtml(items: WatchDigest[], opts: { dashboardUrl: string; searchesLeft: number | null }): string {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;color:#111;max-width:680px">
  <p>Here's your weekly flight price summary.</p>
  ${items.length ? items.map(watchBlock).join("") : "<p>You have no active watches.</p>"}
  <p style="margin-top:24px"><a href="${esc(opts.dashboardUrl)}">Open the dashboard</a></p>
  <p style="color:#777;font-size:12px">${opts.searchesLeft != null ? `Google Flights searches left this month: ${opts.searchesLeft}. ` : ""}Totals marked ~ are estimates (per-adult fare × seats). Prices change quickly, so check before booking.</p>
</div>`;
}

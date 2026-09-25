import { payingSeats, type Trip, type Watch } from "./logic.ts";

/** A fare from either source. Google fares carry the real group total and a price verdict. */
export interface AlertTrip extends Trip {
  price_total?: number | null;
  price_level?: string | null;
  source?: string;
}

export interface PriceAlert {
  watch: Watch;
  trip: AlertTrip;
  baseline: number;
  dropPct: number;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function money(amount: number, currency: string): string {
  return `${Math.round(amount).toLocaleString("pl-PL")} ${currency}`;
}

function hours(minutes: number | null): string {
  if (!minutes) return "?";
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

/** Group total: Google's exact figure when we have it, otherwise per-adult fare × paying seats. */
function groupTotal(trip: AlertTrip, watch: Watch): { amount: number; exact: boolean } {
  if (trip.price_total) return { amount: trip.price_total, exact: true };
  return { amount: trip.price * payingSeats(watch), exact: false };
}

export function alertSubject(alerts: PriceAlert[]): string {
  if (alerts.length === 1) {
    const { trip, watch, dropPct } = alerts[0];
    const seats = payingSeats(watch);
    const total = groupTotal(trip, watch);
    const price = seats > 1
      ? `${total.exact ? "" : "~"}${money(total.amount, watch.currency)} for ${seats}`
      : money(trip.price, watch.currency);
    return `Price drop: ${trip.origin}→${trip.destination} ${price} (−${dropPct}%)`;
  }
  return `${alerts.length} flight price drops`;
}

export function alertHtml(alerts: PriceAlert[]): string {
  const rows = alerts.map(({ watch, trip, baseline, dropPct }) => {
    const nights = Math.round((Date.parse(trip.return_date) - Date.parse(trip.depart_date)) / 86_400_000);
    const book = trip.link ? `<a href="${escapeHtml(trip.link)}">View</a>` : "";
    const seats = payingSeats(watch);
    const total = groupTotal(trip, watch);
    const source = trip.source === "google" ? "Google Flights" : "Aviasales cache";
    return `<tr>
      <td>${escapeHtml(watch.name)}</td>
      <td><b>${escapeHtml(trip.origin)} → ${escapeHtml(trip.destination)}</b><br>
        <small>${trip.depart_date} – ${trip.return_date} (${nights} nights)${trip.airline ? ` · ${escapeHtml(trip.airline)}` : ""}${trip.transfers ? ` · max ${trip.transfers} stop(s)` : " · direct"}<br>
        Journey out: ${hours(trip.duration_to)} · Source: ${source}${trip.price_level ? ` · Google says prices are <b>${escapeHtml(trip.price_level)}</b>` : ""}</small></td>
      <td><b>${money(trip.price, watch.currency)}</b> / person${seats > 1 ? `<br><small>${total.exact ? "" : "~"}${money(total.amount, watch.currency)} for ${seats} seats${total.exact ? " (Google total)" : ""}</small>` : ""}</td>
      <td>${money(baseline, watch.currency)}</td>
      <td style="color:#15803d"><b>−${dropPct}%</b></td>
      <td>${book}</td>
    </tr>`;
  }).join("");

  return `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#111">
  <p>Prices dropped on ${alerts.length === 1 ? "a route" : `${alerts.length} routes`} you're watching:</p>
  <table cellpadding="8" style="border-collapse:collapse;border:1px solid #ddd">
    <thead style="background:#f5f5f5;text-align:left">
      <tr><th>Watch</th><th>Trip</th><th>Price</th><th>Typical (14-day median)</th><th>Drop</th><th></th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="color:#666;font-size:12px">Google Flights totals are priced for your whole group. Aviasales-cache prices are for one adult, so their family total is an estimate. Prices change quickly and seats may run out, so check the final price before you book.</p>
</div>`;
}

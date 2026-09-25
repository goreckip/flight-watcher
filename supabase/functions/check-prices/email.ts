import type { Trip, Watch } from "./logic.ts";

export interface PriceAlert {
  watch: Watch;
  trip: Trip;
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

export function alertSubject(alerts: PriceAlert[]): string {
  if (alerts.length === 1) {
    const { trip, watch, dropPct } = alerts[0];
    return `Price drop: ${trip.origin}→${trip.destination} ${money(trip.price, watch.currency)} (−${dropPct}%)`;
  }
  return `${alerts.length} flight price drops`;
}

export function alertHtml(alerts: PriceAlert[]): string {
  const rows = alerts.map(({ watch, trip, baseline, dropPct }) => {
    const nights = Math.round((Date.parse(trip.return_date) - Date.parse(trip.depart_date)) / 86_400_000);
    const book = trip.link ? `<a href="${escapeHtml(trip.link)}">View</a>` : "";
    return `<tr>
      <td>${escapeHtml(watch.name)}</td>
      <td><b>${escapeHtml(trip.origin)} → ${escapeHtml(trip.destination)}</b><br>
        <small>${trip.depart_date} – ${trip.return_date} (${nights} nights)${trip.airline ? ` · ${escapeHtml(trip.airline)}` : ""}${trip.transfers ? ` · ${trip.transfers} stop(s)` : " · direct"}</small></td>
      <td><b>${money(trip.price, watch.currency)}</b></td>
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
  <p style="color:#666;font-size:12px">Prices come from cached searches and can change quickly, so check the final price before you book.</p>
</div>`;
}

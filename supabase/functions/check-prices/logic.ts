// Pure logic for check-prices. No I/O here, so it can be unit-tested under Node.

export interface Watch {
  id: number;
  name: string;
  origins: string[];
  destinations: string[];
  depart_from: string; // YYYY-MM-DD
  depart_to: string;
  stay_min: number;
  stay_max: number;
  max_transfers: number; // per direction; 0 = direct only
  max_leg_minutes: number | null; // max journey time per direction
  drop_pct: number;
  currency: string;
  adults: number;
  child_ages: number[];
}

export interface SearchRequest {
  origin: string;
  destination: string;
  month: string; // YYYY-MM
}

// Fields we use from a Travelpayouts /aviasales/v3/prices_for_dates item.
export interface TpTicket {
  price: number;
  airline?: string;
  departure_at: string; // ISO with local offset, e.g. 2027-05-12T06:25:00+02:00
  return_at?: string;
  transfers?: number;
  return_transfers?: number;
  duration_to?: number; // minutes
  duration_back?: number;
  link?: string;
}

export interface Trip {
  origin: string;
  destination: string;
  depart_date: string;
  return_date: string;
  price: number;
  airline: string | null;
  transfers: number;
  duration_to: number | null;
  duration_back: number | null;
  link: string | null;
}

export interface RouteEvaluation {
  alert: boolean;
  reason: "building-baseline" | "no-significant-drop" | "already-alerted" | "price-drop";
  baseline: number | null;
  dropPct: number | null;
}

const DAY_MS = 86_400_000;

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

/** Every YYYY-MM from the month of `from` through the month of `to`, inclusive. */
export function monthsBetween(from: string, to: string): string[] {
  let [y, m] = from.slice(0, 7).split("-").map(Number);
  const [toY, toM] = to.slice(0, 7).split("-").map(Number);
  const months: string[] = [];
  while (y < toY || (y === toY && m <= toM)) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return months;
}

/** One API request per origin × destination × departure month still in the future. */
export function buildSearchPlan(watch: Watch, today: string): SearchRequest[] {
  const from = watch.depart_from > today ? watch.depart_from : today;
  if (from > watch.depart_to) return [];
  const months = monthsBetween(from, watch.depart_to);
  const plan: SearchRequest[] = [];
  for (const origin of watch.origins) {
    for (const destination of watch.destinations) {
      for (const month of months) plan.push({ origin, destination, month });
    }
  }
  return plan;
}

/** True if a leg's journey time is within the limit. Unknown times pass only for direct flights. */
function legFits(minutes: number | undefined, transfers: number, limit: number | null): boolean {
  if (limit === null) return true;
  if (minutes === undefined || minutes <= 0) return transfers === 0;
  return minutes <= limit;
}

/** Keep only round trips that fit the watch's date window, stay length, stops and journey-time rules. */
export function ticketsToTrips(
  tickets: TpTicket[],
  req: SearchRequest,
  watch: Watch,
  today: string,
): Trip[] {
  const earliest = watch.depart_from > today ? watch.depart_from : today;
  const trips: Trip[] = [];
  for (const t of tickets) {
    if (!t.return_at || !(t.price > 0)) continue;
    const depart = t.departure_at.slice(0, 10);
    const ret = t.return_at.slice(0, 10);
    if (depart < earliest || depart > watch.depart_to) continue;
    const stay = daysBetween(depart, ret);
    if (stay < watch.stay_min || stay > watch.stay_max) continue;
    const outStops = t.transfers ?? 0;
    const backStops = t.return_transfers ?? 0;
    const transfers = Math.max(outStops, backStops);
    if (transfers > watch.max_transfers) continue;
    if (!legFits(t.duration_to, outStops, watch.max_leg_minutes)) continue;
    if (!legFits(t.duration_back, backStops, watch.max_leg_minutes)) continue;
    trips.push({
      origin: req.origin,
      destination: req.destination,
      depart_date: depart,
      return_date: ret,
      price: t.price,
      airline: t.airline ?? null,
      transfers,
      duration_to: t.duration_to ?? null,
      duration_back: t.duration_back ?? null,
      link: t.link ? `https://www.aviasales.com${t.link}` : null,
    });
  }
  return trips;
}

/**
 * Fares are quoted per adult. Children aged 2+ need their own seat and low-cost airlines
 * charge them the adult fare, so they count as full seats. Infants (<2) fly on a lap for a
 * small fee and are left out of the estimate.
 */
export function payingSeats(watch: Watch): number {
  return watch.adults + watch.child_ages.filter((age) => age >= 2).length;
}

/** Collapse duplicates (same route + dates) to the cheapest fare. */
export function cheapestPerTrip(trips: Trip[]): Trip[] {
  const best = new Map<string, Trip>();
  for (const t of trips) {
    const key = `${t.origin}|${t.destination}|${t.depart_date}|${t.return_date}`;
    const current = best.get(key);
    if (!current || t.price < current.price) best.set(key, t);
  }
  return [...best.values()];
}

/** Group trips by route and return the cheapest trip for each. */
export function cheapestPerRoute(trips: Trip[]): Trip[] {
  const best = new Map<string, Trip>();
  for (const t of trips) {
    const key = `${t.origin}|${t.destination}`;
    const current = best.get(key);
    if (!current || t.price < current.price) best.set(key, t);
  }
  return [...best.values()];
}

export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median of empty list");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Decide whether today's cheapest fare on a route is worth an email.
 *
 * - baseline = median of the route's daily cheapest fare over previous days
 *   (median, not yesterday's price, so one noisy day doesn't trigger alerts)
 * - needs `minHistory` days of data before it will alert at all
 * - a route already alerted recently only alerts again if the price beats that alert
 */
export function evaluateRoute(
  todayPrice: number,
  history: number[],
  dropThresholdPct: number,
  recentAlertPrices: number[],
  minHistory = 3,
): RouteEvaluation {
  if (history.length < minHistory) {
    return { alert: false, reason: "building-baseline", baseline: null, dropPct: null };
  }
  const baseline = median(history);
  const dropPct = Math.round(((baseline - todayPrice) / baseline) * 1000) / 10;
  if (dropPct < dropThresholdPct) {
    return { alert: false, reason: "no-significant-drop", baseline, dropPct };
  }
  if (recentAlertPrices.length > 0 && todayPrice >= Math.min(...recentAlertPrices)) {
    return { alert: false, reason: "already-alerted", baseline, dropPct };
  }
  return { alert: true, reason: "price-drop", baseline, dropPct };
}

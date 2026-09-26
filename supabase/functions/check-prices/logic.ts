// Pure logic for check-prices. No I/O here, so it can be unit-tested under Node.

export interface Watch {
  id: number;
  name: string;
  origins: string[];
  destinations: string[];
  depart_from: string; // YYYY-MM-DD
  depart_to: string;
  return_by: string | null; // latest allowed return date
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
  reason: "building-baseline" | "no-significant-drop" | "already-alerted" | "price-drop" | "new-low";
  baseline: number | null; // what the price is compared with (median, or previous lowest for new-low)
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

export type RejectReason =
  | "no-return-flight"
  | "outside-departure-window"
  | "back-too-late"
  | "stay-length"
  | "too-many-stops"
  | "journey-too-long-or-unknown";

/** Why a fare doesn't match the watch, or null if it does. */
export function rejectReason(t: TpTicket, watch: Watch, today: string): RejectReason | null {
  const earliest = watch.depart_from > today ? watch.depart_from : today;
  if (!t.return_at || !(t.price > 0)) return "no-return-flight";
  const depart = t.departure_at.slice(0, 10);
  const ret = t.return_at.slice(0, 10);
  if (depart < earliest || depart > watch.depart_to) return "outside-departure-window";
  if (watch.return_by && ret > watch.return_by) return "back-too-late";
  const stay = daysBetween(depart, ret);
  if (stay < watch.stay_min || stay > watch.stay_max) return "stay-length";
  const outStops = t.transfers ?? 0;
  const backStops = t.return_transfers ?? 0;
  if (Math.max(outStops, backStops) > watch.max_transfers) return "too-many-stops";
  if (
    !legFits(t.duration_to, outStops, watch.max_leg_minutes) ||
    !legFits(t.duration_back, backStops, watch.max_leg_minutes)
  ) return "journey-too-long-or-unknown";
  return null;
}

/** How many fares were dropped by each rule. */
export function countRejections(tickets: TpTicket[], watch: Watch, today: string): Partial<Record<RejectReason, number>> {
  const counts: Partial<Record<RejectReason, number>> = {};
  for (const t of tickets) {
    const reason = rejectReason(t, watch, today);
    if (reason) counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

/** Keep only round trips that fit the watch's date window, stay length, stops and journey-time rules. */
export function ticketsToTrips(
  tickets: TpTicket[],
  req: SearchRequest,
  watch: Watch,
  today: string,
): Trip[] {
  const trips: Trip[] = [];
  for (const t of tickets) {
    if (rejectReason(t, watch, today)) continue;
    const depart = t.departure_at.slice(0, 10);
    const ret = t.return_at!.slice(0, 10);
    const transfers = Math.max(t.transfers ?? 0, t.return_transfers ?? 0);
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

// ---------- exact-date searches (Google Flights via SerpApi) ----------

export interface DateCombo {
  depart: string;
  ret: string;
}

export const comboKey = (c: DateCombo) => `${c.depart}|${c.ret}`;

/** Every departure/return pair that fits the watch: window, nights, back-by date. */
export function tripCombos(watch: Watch, today: string): DateCombo[] {
  const combos: DateCombo[] = [];
  const first = watch.depart_from > today ? watch.depart_from : today;
  for (let depart = first; depart <= watch.depart_to; depart = addDays(depart, 1)) {
    for (let nights = watch.stay_min; nights <= watch.stay_max; nights++) {
      const ret = addDays(depart, nights);
      if (watch.return_by && ret > watch.return_by) continue;
      combos.push({ depart, ret });
    }
  }
  return combos;
}

/**
 * Choose which date pairs to search today, given a small daily budget:
 * 1. re-check the cheapest known pair (tracks the best option's price day to day),
 * 2. then pairs never searched, spread across the window rather than in date order,
 * 3. then the pairs searched longest ago.
 * Pairs already searched today are skipped, so repeated runs don't burn quota.
 */
export function pickCombos(
  combos: DateCombo[],
  lastChecked: Map<string, string>,
  cheapestKey: string | null,
  today: string,
  n: number,
): DateCombo[] {
  const due = combos.filter((c) => lastChecked.get(comboKey(c)) !== today);
  const picked: DateCombo[] = [];
  const cheapest = cheapestKey ? due.find((c) => comboKey(c) === cheapestKey) : undefined;
  if (cheapest) picked.push(cheapest);

  const spread = (i: number) => (i * 0.6180339887) % 1; // golden-ratio stride
  const never = due
    .map((c, i) => ({ c, order: spread(i) }))
    .filter(({ c }) => !lastChecked.has(comboKey(c)))
    .sort((a, b) => a.order - b.order)
    .map(({ c }) => c);
  const stale = due
    .filter((c) => lastChecked.has(comboKey(c)))
    .sort((a, b) => lastChecked.get(comboKey(a))!.localeCompare(lastChecked.get(comboKey(b))!));

  for (const c of [...never, ...stale]) {
    if (picked.length >= n) break;
    if (!picked.includes(c)) picked.push(c);
  }
  return picked.slice(0, n);
}

/** Google Flights passenger buckets: adults 12+, children 2–11, lap infants under 2. */
export function googlePassengers(watch: Watch) {
  const ages = watch.child_ages ?? [];
  return {
    adults: watch.adults + ages.filter((a) => a >= 12).length,
    children: ages.filter((a) => a >= 2 && a < 12).length,
    infants_on_lap: ages.filter((a) => a < 2).length,
  };
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

const pctBelow = (price: number, ref: number) => Math.round(((ref - price) / ref) * 1000) / 10;

/**
 * Decide whether the current best fare on a route is worth an email. Two triggers:
 *
 * - price-drop: at least `dropThresholdPct` below the median of earlier checks
 *   (median, not the last price, so one noisy check doesn't trigger alerts);
 *   needs `minHistory` earlier checks
 * - new-low: at least `newLowPct` below the lowest price seen before; needs 1 earlier check.
 *   Catches cheaper dates found by the rotation while the median is still being built.
 *
 * A route already alerted recently only alerts again if the price beats that alert.
 */
export function evaluateRoute(
  price: number,
  history: number[],
  dropThresholdPct: number,
  recentAlertPrices: number[],
  minHistory = 3,
  newLowPct = 3,
): RouteEvaluation {
  if (history.length === 0) {
    return { alert: false, reason: "building-baseline", baseline: null, dropPct: null };
  }
  const alreadyAlerted = recentAlertPrices.length > 0 && price >= Math.min(...recentAlertPrices);

  if (history.length >= minHistory) {
    const baseline = median(history);
    const dropPct = pctBelow(price, baseline);
    if (dropPct >= dropThresholdPct) {
      return alreadyAlerted
        ? { alert: false, reason: "already-alerted", baseline, dropPct }
        : { alert: true, reason: "price-drop", baseline, dropPct };
    }
  }

  const previousLow = Math.min(...history);
  const belowLow = pctBelow(price, previousLow);
  if (belowLow >= newLowPct) {
    return alreadyAlerted
      ? { alert: false, reason: "already-alerted", baseline: previousLow, dropPct: belowLow }
      : { alert: true, reason: "new-low", baseline: previousLow, dropPct: belowLow };
  }

  if (history.length < minHistory) {
    return { alert: false, reason: "building-baseline", baseline: null, dropPct: null };
  }
  const baseline = median(history);
  return { alert: false, reason: "no-significant-drop", baseline, dropPct: pctBelow(price, baseline) };
}

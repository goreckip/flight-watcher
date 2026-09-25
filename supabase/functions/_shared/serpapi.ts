// Google Flights via SerpApi: exact-date round-trip searches priced for the whole party.
import { type DateCombo, googlePassengers, payingSeats, type Watch } from "../check-prices/logic.ts";

const ENDPOINT = "https://serpapi.com/search.json";

export interface GoogleFare {
  origin: string;
  destination: string;
  depart_date: string;
  return_date: string;
  price: number; // per paying seat (price_total / seats), comparable with Travelpayouts
  price_total: number; // Google's price for the whole party
  price_level: string | null; // Google's verdict for the route: low / typical / high
  airline: string | null;
  transfers: number; // outbound stops (Google applies the same stop/duration filters both ways)
  duration_to: number | null;
  duration_back: number | null;
  link: string | null;
}

interface SerpLeg {
  departure_airport?: { id?: string };
  arrival_airport?: { id?: string };
  airline?: string;
}

interface SerpItinerary {
  flights?: SerpLeg[];
  layovers?: unknown[];
  total_duration?: number;
  price?: number;
}

/** Google Flights "stops" filter: 1 = nonstop, 2 = up to 1 stop, 3 = up to 2 stops, 0 = any. */
function stopsParam(maxTransfers: number): string {
  return maxTransfers <= 0 ? "1" : maxTransfers === 1 ? "2" : maxTransfers === 2 ? "3" : "0";
}

function googleFlightsUrl(watch: Watch, combo: DateCombo): string {
  const q = `Flights from ${watch.origins.join(",")} to ${watch.destinations.join(",")} on ${combo.depart} through ${combo.ret}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}&curr=${watch.currency}`;
}

export interface GoogleSearchReport {
  request: Record<string, string>; // without the API key
  error: string | null;
  priceLevel: string | null;
  itineraries: {
    price: number | null;
    transfers: number;
    totalDuration: number | null;
    airlines: string;
    via: string;
    kept: boolean;
    reason: string | null;
  }[];
  fares: GoogleFare[];
}

/** Cheapest fare per actual route for one date pair. Throws on API errors; "no results" returns []. */
export async function searchGoogleFlights(watch: Watch, combo: DateCombo): Promise<GoogleFare[]> {
  const report = await googleSearchReport(watch, combo);
  if (report.error) throw new Error(report.error);
  return report.fares;
}

/**
 * One Google Flights search with a full account of what came back and why each itinerary
 * was kept or dropped. `googleFilters: false` leaves the stop/duration filters off the request
 * (our own checks still run), to see what the filters hide.
 */
export async function googleSearchReport(
  watch: Watch,
  combo: DateCombo,
  googleFilters = true,
): Promise<GoogleSearchReport> {
  const key = Deno.env.get("SERPAPI_KEY");
  if (!key) throw new Error("Missing env var SERPAPI_KEY");

  const pax = googlePassengers(watch);
  const params = new URLSearchParams({
    engine: "google_flights",
    departure_id: watch.origins.join(","),
    arrival_id: watch.destinations.join(","),
    outbound_date: combo.depart,
    return_date: combo.ret,
    type: "1",
    currency: watch.currency,
    hl: "en",
    gl: "pl",
    adults: String(pax.adults),
    children: String(pax.children),
    infants_on_lap: String(pax.infants_on_lap),
    sort_by: "2",
  });
  if (googleFilters) {
    params.set("stops", stopsParam(watch.max_transfers));
    if (watch.max_leg_minutes) params.set("max_duration", String(watch.max_leg_minutes));
  }
  const report: GoogleSearchReport = {
    request: Object.fromEntries(params),
    error: null,
    priceLevel: null,
    itineraries: [],
    fares: [],
  };
  params.set("api_key", key);

  const res = await fetch(`${ENDPOINT}?${params}`);
  const body = await res.json().catch(() => ({}));
  if (body.error) {
    if (!/hasn't returned any results|no results/i.test(body.error)) report.error = `SerpApi: ${body.error}`;
    return report;
  }
  if (!res.ok) {
    report.error = `SerpApi HTTP ${res.status}`;
    return report;
  }

  const itineraries: SerpItinerary[] = [...(body.best_flights ?? []), ...(body.other_flights ?? [])];
  const seats = payingSeats(watch);
  report.priceLevel = body.price_insights?.price_level ?? null;

  const best = new Map<string, GoogleFare>();
  for (const it of itineraries) {
    const legs = it.flights ?? [];
    const transfers = (it.layovers ?? []).length;
    const row = {
      price: typeof it.price === "number" ? it.price : null,
      transfers,
      totalDuration: it.total_duration ?? null,
      airlines: [...new Set(legs.map((l) => l.airline).filter(Boolean))].join(" + "),
      via: legs.slice(0, -1).map((l) => l.arrival_airport?.id).filter(Boolean).join(", "),
      kept: false,
      reason: null as string | null,
    };
    report.itineraries.push(row);
    if (!legs.length || !(typeof it.price === "number" && it.price > 0)) {
      row.reason = "no price";
      continue;
    }
    if (transfers > watch.max_transfers) {
      row.reason = "too many stops";
      continue;
    }
    if (watch.max_leg_minutes && (it.total_duration ?? 0) > watch.max_leg_minutes) {
      row.reason = "outbound too long";
      continue;
    }
    row.kept = true;

    const origin = legs[0].departure_airport?.id ?? watch.origins[0];
    const destination = legs.at(-1)!.arrival_airport?.id ?? watch.destinations[0];
    const fare: GoogleFare = {
      origin,
      destination,
      depart_date: combo.depart,
      return_date: combo.ret,
      price: Math.round(it.price / seats),
      price_total: it.price,
      price_level: report.priceLevel,
      airline: [...new Set(legs.map((l) => l.airline).filter(Boolean))].join(" + ") || null,
      transfers,
      duration_to: it.total_duration ?? null,
      duration_back: null,
      link: googleFlightsUrl(watch, combo),
    };
    const routeKey = `${origin}|${destination}`;
    const current = best.get(routeKey);
    if (!current || fare.price_total < current.price_total) best.set(routeKey, fare);
  }
  report.fares = [...best.values()];
  return report;
}

/** Remaining searches this month (the Account API is free and doesn't use quota). */
export async function serpApiAccount(): Promise<{ searchesLeft: number | null; usedThisMonth: number | null } | null> {
  const key = Deno.env.get("SERPAPI_KEY");
  if (!key) return null;
  const res = await fetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(key)}`);
  if (!res.ok) return null;
  const body = await res.json();
  return {
    searchesLeft: body.total_searches_left ?? body.plan_searches_left ?? null,
    usedThisMonth: body.this_month_usage ?? null,
  };
}

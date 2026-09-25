// Travelpayouts (Aviasales) Data API client, shared by check-prices and api.
import type { SearchRequest, TpTicket } from "../check-prices/logic.ts";

const PRICES_FOR_DATES = "https://api.travelpayouts.com/aviasales/v3/prices_for_dates";

export interface FetchOptions {
  currency: string;
  directOnly: boolean;
  oneWay?: boolean; // default false: round trips
}

/** Cheapest cached fares for one route and departure month. */
export async function fetchTickets(search: SearchRequest, opts: FetchOptions): Promise<TpTicket[]> {
  const token = Deno.env.get("TRAVELPAYOUTS_TOKEN");
  if (!token) throw new Error("Missing env var TRAVELPAYOUTS_TOKEN");

  const params = new URLSearchParams({
    origin: search.origin,
    destination: search.destination,
    departure_at: search.month,
    one_way: String(opts.oneWay ?? false),
    direct: String(opts.directOnly),
    currency: opts.currency.toLowerCase(),
    sorting: "price",
    unique: "false",
    limit: "1000",
  });
  const res = await fetch(`${PRICES_FOR_DATES}?${params}`, { headers: { "X-Access-Token": token } });
  if (!res.ok) throw new Error(`Travelpayouts HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (!body.success) throw new Error(`Travelpayouts error: ${JSON.stringify(body.error ?? body).slice(0, 200)}`);
  return body.data ?? [];
}

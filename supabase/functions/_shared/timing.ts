// "When are prices lowest?" from repeated observations of the same itineraries. Pure, unit-tested.
//
// Comparing a morning search with an evening one directly would mostly compare different trips
// (each Google search looks at other dates). Instead, each observation is compared with the average
// price of *the same itinerary* (source + route + dates), and those deviations are averaged per
// time-of-day slot and per weekday, in the owner's time zone (TIMEZONE, default Europe/Warsaw).

export interface Observation {
  source: string;
  origin: string;
  destination: string;
  depart_date: string;
  return_date: string;
  price: number;
  observed_at: string; // ISO timestamp
}

export type Slot = "morning" | "afternoon" | "evening";

export interface Bucket<K> {
  key: K;
  avgDeviationPct: number; // negative = cheaper than that itinerary's average
  observations: number;
}

export interface TimingInsight {
  itineraries: number; // itineraries seen at least twice
  observations: number; // observations used
  bySlot: Bucket<Slot>[];
  byWeekday: Bucket<string>[]; // Mon..Sun
  reliable: boolean;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const DEFAULT_TIMEZONE = "Europe/Warsaw";

const formatters = new Map<string, { hour: Intl.DateTimeFormat; day: Intl.DateTimeFormat }>();
function fmt(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = {
      hour: new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: tz }),
      day: new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: tz }),
    };
    formatters.set(tz, f);
  }
  return f;
}

export function slotOf(iso: string, tz = DEFAULT_TIMEZONE): Slot {
  const h = Number(fmt(tz).hour.format(new Date(iso)));
  return h < 11 ? "morning" : h < 17 ? "afternoon" : "evening";
}

export function weekdayOf(iso: string, tz = DEFAULT_TIMEZONE): string {
  return fmt(tz).day.format(new Date(iso));
}

/** Minimum data before the result is presented as meaningful. */
const MIN_OBSERVATIONS = 30;
const MIN_PER_BUCKET = 5;

export function timingInsight(observations: Observation[], tz = DEFAULT_TIMEZONE): TimingInsight {
  const byItinerary = new Map<string, Observation[]>();
  for (const o of observations) {
    const key = `${o.source}|${o.origin}|${o.destination}|${o.depart_date}|${o.return_date}`;
    const list = byItinerary.get(key) ?? [];
    list.push(o);
    byItinerary.set(key, list);
  }

  const slotDev = new Map<Slot, number[]>();
  const dayDev = new Map<string, number[]>();
  let itineraries = 0;
  let used = 0;
  for (const list of byItinerary.values()) {
    if (list.length < 2) continue;
    const mean = list.reduce((s, o) => s + Number(o.price), 0) / list.length;
    if (!(mean > 0)) continue;
    itineraries++;
    for (const o of list) {
      const dev = ((Number(o.price) - mean) / mean) * 100;
      const s = slotOf(o.observed_at, tz);
      const d = weekdayOf(o.observed_at, tz);
      slotDev.set(s, [...(slotDev.get(s) ?? []), dev]);
      dayDev.set(d, [...(dayDev.get(d) ?? []), dev]);
      used++;
    }
  }

  const bucket = <K>(key: K, devs: number[] | undefined): Bucket<K> | null =>
    devs?.length
      ? { key, avgDeviationPct: Math.round((devs.reduce((a, b) => a + b, 0) / devs.length) * 10) / 10, observations: devs.length }
      : null;

  const bySlot = (["morning", "afternoon", "evening"] as Slot[])
    .map((s) => bucket(s, slotDev.get(s))).filter((b): b is Bucket<Slot> => b !== null);
  const byWeekday = WEEKDAYS
    .map((d) => bucket(d, dayDev.get(d))).filter((b): b is Bucket<string> => b !== null);

  const reliable = used >= MIN_OBSERVATIONS &&
    bySlot.filter((b) => b.observations >= MIN_PER_BUCKET).length >= 2;

  return { itineraries, observations: used, bySlot, byWeekday, reliable };
}

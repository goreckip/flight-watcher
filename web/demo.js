// Sample data for ?demo, so the dashboard can be shown without the password.
// The trips are made up: a family Easter break in Lisbon and a couple's spring trip to Spain.

function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

function isoDaysAgo(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

const SEATS_LISBON = 4; // 2 adults + 2 children

const watches = [
  {
    id: 1, name: "Lisbon spring break", origins: ["WAW"], destinations: ["LIS"],
    depart_from: "2027-03-27", depart_to: "2027-04-05", return_by: "2027-04-11",
    stay_min: 6, stay_max: 9, max_transfers: 1, max_leg_minutes: 300,
    adults: 2, child_ages: [6, 10], drop_pct: 10, currency: "PLN", active: true,
  },
  {
    id: 2, name: "Spain in May", origins: ["KRK"], destinations: ["BCN", "AGP", "VLC"],
    depart_from: "2027-05-01", depart_to: "2027-05-24", return_by: "2027-05-31",
    stay_min: 4, stay_max: 7, max_transfers: 0, max_leg_minutes: null,
    adults: 2, child_ages: [], drop_pct: 10, currency: "PLN", active: true,
  },
];

function series(watchId, origin, destination, base, seed, days = 24, google = false) {
  const rand = rng(seed);
  const rows = [];
  let price = base;
  for (let d = days - 1; d >= 0; d--) {
    price = Math.max(base * 0.7, price + (rand() - 0.52) * base * 0.06);
    if (d === 0) price *= 0.87; // a visible drop today
    rows.push({
      watch_id: watchId, origin, destination, checked_on: isoDaysAgo(d),
      price: Math.round(price), currency: "PLN",
      price_total: google ? Math.round(price) * SEATS_LISBON : null,
      price_level: google ? (d === 0 ? "low" : "typical") : null,
      source: google ? "google" : "travelpayouts",
      depart_date: google ? "2027-03-29" : "2027-05-08",
      return_date: google ? "2027-04-05" : "2027-05-13",
      airline: google ? "TP" : "FR",
    });
  }
  return rows;
}

const daily = [
  ...series(1, "WAW", "LIS", 1290, 7, 24, true),
  ...series(2, "KRK", "BCN", 520, 11),
  ...series(2, "KRK", "AGP", 610, 23),
  ...series(2, "KRK", "VLC", 560, 5, 12),
].sort((a, b) => a.checked_on.localeCompare(b.checked_on));

// Per-check points (3 a day) for the last 10 days of the Lisbon watch.
const points = (() => {
  const rand = rng(99);
  const list = [];
  let price = 1320;
  for (let d = 9; d >= 0; d--) {
    for (const [h, m] of [[5, 17], [12, 5], [18, 5]]) {
      const at = new Date(Date.now() - d * 86_400_000);
      at.setUTCHours(h, m, 0, 0);
      if (at > new Date()) continue;
      price = Math.round(Math.max(1080, price + (rand() - 0.55) * 40 - (h === 18 ? 10 : 0)));
      list.push({
        run_id: list.length + 1, watch_id: 1, checked_at: at.toISOString(), origin: "WAW", destination: "LIS",
        price, price_total: price * SEATS_LISBON, price_level: price < 1200 ? "low" : "typical",
        depart_date: "2027-03-30", return_date: "2027-04-06",
        airline: ["TAP Air Portugal", "LOT", "TAP Air Portugal", "Lufthansa", "LOT", "TAP Air Portugal"][Math.floor(rand() * 6)],
        source: "google",
      });
    }
  }
  return list;
})();

const timing = {
  1: {
    itineraries: 9, observations: 84, reliable: true,
    bySlot: [
      { key: "morning", avgDeviationPct: 0.9, observations: 28 },
      { key: "afternoon", avgDeviationPct: 0.4, observations: 29 },
      { key: "evening", avgDeviationPct: -1.3, observations: 27 },
    ],
    byWeekday: [
      { key: "Mon", avgDeviationPct: 0.6, observations: 12 }, { key: "Tue", avgDeviationPct: -1.9, observations: 12 },
      { key: "Wed", avgDeviationPct: -0.7, observations: 12 }, { key: "Thu", avgDeviationPct: 0.2, observations: 12 },
      { key: "Fri", avgDeviationPct: 1.1, observations: 12 }, { key: "Sat", avgDeviationPct: 0.8, observations: 12 },
      { key: "Sun", avgDeviationPct: -0.1, observations: 12 },
    ],
  },
};

const alerts = [
  {
    id: 1, watch_id: 1, origin: "WAW", destination: "LIS", depart_date: "2027-03-30",
    return_date: "2027-04-06", price: 1118, baseline_price: 1290, drop_pct: 13.3, currency: "PLN",
    sent_at: new Date().toISOString(),
  },
];

function trips(watchId) {
  const rand = rng(watchId * 97);
  const list = [];
  const lisbon = watchId === 1;
  const routes = lisbon ? [["WAW", "LIS"]] : [["KRK", "BCN"], ["KRK", "AGP"], ["KRK", "VLC"]];
  for (let i = 0; i < 10; i++) {
    const [origin, destination] = routes[i % routes.length];
    const depart = lisbon
      ? new Date(Date.UTC(2027, 2, 27 + Math.floor(rand() * 7)))
      : new Date(Date.UTC(2027, 4, 1 + Math.floor(rand() * 23)));
    const nights = lisbon ? 6 + Math.floor(rand() * 3) : 4 + Math.floor(rand() * 4);
    const ret = new Date(depart.getTime() + nights * 86_400_000);
    const stops = lisbon ? (rand() < 0.5 ? 0 : 1) : 0;
    list.push({
      origin, destination,
      source: lisbon ? "google" : "travelpayouts",
      checked_on: isoDaysAgo(lisbon ? i % 5 : 0),
      price_level: lisbon ? "typical" : null,
      depart_date: depart.toISOString().slice(0, 10),
      return_date: ret.toISOString().slice(0, 10),
      price: Math.round((lisbon ? 1120 : 480) + rand() * 300),
      currency: "PLN",
      airline: lisbon ? (stops ? "Lufthansa" : (rand() < 0.5 ? "TAP Air Portugal" : "LOT")) : (rand() < 0.5 ? "FR" : "W6"),
      transfers: stops,
      duration_to: stops ? 270 + Math.floor(rand() * 30) : 255,
      duration_back: stops ? 280 + Math.floor(rand() * 20) : 250,
      link: null,
    });
  }
  return list.sort((a, b) => a.price - b.price);
}

export async function demoApi(method, path) {
  if (method === "GET" && path === "/overview") {
    return {
      watches, daily, alerts, points, timing,
      google: {
        enabled: true, freshDays: 12, searchesToday: 3, dailyLimit: 3,
        account: { searchesLeft: 64, usedThisMonth: 36 }, coverage: { 1: { checked: 27, total: 34 } },
      },
      runs: points.slice(-30).reverse().map((p) => ({
        id: p.run_id, trigger: p.run_id % 7 === 0 ? "manual" : "schedule", started_at: p.checked_at,
        finished_at: p.checked_at, google_searches: 1, fares: 14 + (p.run_id % 5), alerts_sent: p.run_id % 11 === 0 ? 1 : 0, errors: [],
      })),
    };
  }
  const match = path.match(/^\/watches\/(\d+)\/trips$/);
  if (method === "GET" && match) return { checked_on: isoDaysAgo(0), trips: trips(Number(match[1])) };
  throw new Error("Demo mode: changes are disabled. Sign in to manage your own watches.");
}

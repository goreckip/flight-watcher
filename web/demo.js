// Sample data for ?demo, so the dashboard can be shown without the password.

function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

function isoDaysAgo(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

const watches = [
  {
    id: 1, name: "Athens winter break", origins: ["GDN"], destinations: ["ATH"],
    depart_from: "2027-01-29", depart_to: "2027-02-09", return_by: "2027-02-14",
    stay_min: 5, stay_max: 7, max_transfers: 1, max_leg_minutes: 390,
    adults: 2, child_ages: [3, 7, 9], drop_pct: 10, currency: "PLN", active: true,
  },
  {
    id: 2, name: "Spain in spring", origins: ["GDN"], destinations: ["BCN", "AGP", "MAD"],
    depart_from: "2027-04-15", depart_to: "2027-06-07", return_by: "2027-06-15",
    stay_min: 5, stay_max: 8, max_transfers: 0, max_leg_minutes: null,
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
      price_total: google ? Math.round(price) * 5 : null,
      price_level: google ? (d === 0 ? "low" : "typical") : null,
      source: google ? "google" : "travelpayouts",
      depart_date: "2027-02-01", return_date: "2027-02-07", airline: "LO",
    });
  }
  return rows;
}

const daily = [
  ...series(1, "GDN", "ATH", 980, 7, 24, true),
  ...series(2, "GDN", "BCN", 520, 11),
  ...series(2, "GDN", "AGP", 610, 23),
  ...series(2, "GDN", "MAD", 700, 5, 12),
].sort((a, b) => a.checked_on.localeCompare(b.checked_on));

// Per-check points (3 a day) for the last 10 days of the Athens watch.
const points = (() => {
  const rand = rng(99);
  const list = [];
  let price = 1010;
  for (let d = 9; d >= 0; d--) {
    for (const [h, m] of [[5, 17], [12, 5], [18, 5]]) {
      const at = new Date(Date.now() - d * 86_400_000);
      at.setUTCHours(h, m, 0, 0);
      if (at > new Date()) continue;
      price = Math.round(Math.max(820, price + (rand() - 0.55) * 30 - (h === 18 ? 8 : 0)));
      list.push({
        watch_id: 1, checked_at: at.toISOString(), origin: "GDN", destination: "ATH",
        price, price_total: price * 5, price_level: price < 930 ? "low" : "typical",
        depart_date: "2027-02-02", return_date: "2027-02-08", airline: "KLM", source: "google",
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
    id: 1, watch_id: 1, origin: "GDN", destination: "ATH", depart_date: "2027-02-01",
    return_date: "2027-02-07", price: 846, baseline_price: 975, drop_pct: 13.2, currency: "PLN",
    sent_at: new Date().toISOString(),
  },
];

function trips(watchId) {
  const rand = rng(watchId * 97);
  const list = [];
  const routes = watchId === 1 ? [["GDN", "ATH"]] : [["GDN", "BCN"], ["GDN", "AGP"], ["GDN", "MAD"]];
  for (let i = 0; i < 10; i++) {
    const [origin, destination] = routes[i % routes.length];
    const start = watchId === 1 ? 29 + Math.floor(rand() * 9) : 15 + Math.floor(rand() * 40);
    const depart = watchId === 1
      ? new Date(Date.UTC(2027, 0, start))
      : new Date(Date.UTC(2027, 3, start));
    const nights = 5 + Math.floor(rand() * 3);
    const ret = new Date(depart.getTime() + nights * 86_400_000);
    const stops = watchId === 1 ? (rand() < 0.3 ? 0 : 1) : 0;
    const google = watchId === 1;
    list.push({
      origin, destination,
      source: google ? "google" : "travelpayouts",
      checked_on: isoDaysAgo(google ? i % 5 : 0),
      price_level: google ? "typical" : null,
      depart_date: depart.toISOString().slice(0, 10),
      return_date: ret.toISOString().slice(0, 10),
      price: Math.round((watchId === 1 ? 850 : 480) + rand() * 300),
      currency: "PLN",
      airline: stops ? "LO" : (watchId === 1 ? "A3" : "FR"),
      transfers: stops,
      duration_to: stops ? 300 + Math.floor(rand() * 80) : 180,
      duration_back: stops ? 310 + Math.floor(rand() * 70) : 185,
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
        account: { searchesLeft: 64, usedThisMonth: 36 }, coverage: { 1: { checked: 27, total: 33 } },
      },
      runs: [{
        trigger: "schedule", started_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
        finished_at: new Date().toISOString(), google_searches: 3, fares: 41, alerts_sent: 1, errors: [],
      }],
    };
  }
  const match = path.match(/^\/watches\/(\d+)\/trips$/);
  if (method === "GET" && match) return { checked_on: isoDaysAgo(0), trips: trips(Number(match[1])) };
  throw new Error("Demo mode: changes are disabled. Sign in to manage your own watches.");
}

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

function series(watchId, origin, destination, base, seed, days = 24) {
  const rand = rng(seed);
  const rows = [];
  let price = base;
  for (let d = days - 1; d >= 0; d--) {
    price = Math.max(base * 0.7, price + (rand() - 0.52) * base * 0.06);
    if (d === 0) price *= 0.87; // a visible drop today
    rows.push({
      watch_id: watchId, origin, destination, checked_on: isoDaysAgo(d),
      price: Math.round(price), currency: "PLN",
      depart_date: "2027-02-01", return_date: "2027-02-07", airline: "LO",
    });
  }
  return rows;
}

const daily = [
  ...series(1, "GDN", "ATH", 980, 7),
  ...series(2, "GDN", "BCN", 520, 11),
  ...series(2, "GDN", "AGP", 610, 23),
  ...series(2, "GDN", "MAD", 700, 5, 12),
].sort((a, b) => a.checked_on.localeCompare(b.checked_on));

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
    list.push({
      origin, destination,
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
  if (method === "GET" && path === "/overview") return { watches, daily, alerts };
  const match = path.match(/^\/watches\/(\d+)\/trips$/);
  if (method === "GET" && match) return { checked_on: isoDaysAgo(0), trips: trips(Number(match[1])) };
  throw new Error("Demo mode: changes are disabled. Sign in to manage your own watches.");
}

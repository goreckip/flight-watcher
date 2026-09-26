import { demoApi } from "./demo.js?v=__VERSION__";

const API_URL = "https://uorpnghoagbnwrdyrgre.supabase.co/functions/v1/api";
const DEMO = new URLSearchParams(location.search).has("demo");
const PASSWORD_KEY = "flight-watcher-password";
const BASELINE_DAYS = 14;

// ---------- small helpers ----------

const $ = (sel, el = document) => el.querySelector(sel);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* private mode */ } },
};

const DAY_MS = 86_400_000;
const addDays = (iso, n) => new Date(Date.parse(iso) + n * DAY_MS).toISOString().slice(0, 10);
const nightsBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const shortFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const fmtDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : "–");
const fmtShort = (iso) => (iso ? shortFmt.format(new Date(iso)) : "–");
const money = (n, cur) => `${Math.round(n).toLocaleString("en-GB")} ${cur}`;
const hours = (min) => (min ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}` : "?");

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Children aged 2+ need a seat and usually pay the adult fare; lap infants are left out. */
const payingSeats = (w) => w.adults + (w.child_ages ?? []).filter((a) => a >= 2).length;

function travellers(w) {
  const kids = w.child_ages ?? [];
  const adults = `${w.adults} adult${w.adults === 1 ? "" : "s"}`;
  if (!kids.length) return adults;
  return `${adults} + ${kids.length} kid${kids.length === 1 ? "" : "s"} (${kids.join(", ")})`;
}

function stopsLabel(n) {
  return n === 0 ? "Direct only" : `≤ ${n} stop${n === 1 ? "" : "s"}`;
}

function toast(message, ms = 5000) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------- API ----------

let password = storage.get(PASSWORD_KEY);

async function api(method, path, body) {
  if (DEMO) return demoApi(method, path, body);
  const res = await fetch(API_URL + path, {
    method,
    headers: {
      "x-app-password": password ?? "",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    signOut();
    throw new Error("Wrong password");
  }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

// ---------- auth ----------

function showLogin() {
  $("#login").hidden = false;
  $("#app").hidden = true;
  $("#topbar-actions").hidden = true;
  $("#login-password").focus();
}

function signOut() {
  password = null;
  storage.remove(PASSWORD_KEY);
  showLogin();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = $("#login-error");
  errorEl.hidden = true;
  password = $("#login-password").value;
  try {
    await api("GET", "/auth");
    storage.set(PASSWORD_KEY, password);
    await start();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
    showLogin();
  }
});

$("#btn-logout").addEventListener("click", signOut);

// ---------- rendering ----------

let data = { watches: [], daily: [], alerts: [] };
const charts = new Map();

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const MIN_EARLIER_CHECKS = 3; // same rule as the email alerts

/**
 * Summary numbers for one watch, on the same basis as the alerts: the best fare at the latest
 * check, compared with the median of earlier checks (last 14 days) and the previous lowest.
 */
function summarize(watch) {
  const { all, slots, sortKey } = chartPoints(watch);
  if (!all.length) return null;

  // Best fare across routes at each check
  const bestAt = new Map();
  for (const p of all) {
    const k = sortKey(p);
    const cur = bestAt.get(k);
    if (!cur || Number(p.price) < Number(cur.price)) bestAt.set(k, p);
  }
  const latest = slots.at(-1);
  const best = bestAt.get(latest.key);
  const since = addDays(latest.day, -BASELINE_DAYS);
  const earlier = slots.slice(0, -1).filter((s) => s.day >= since).map((s) => Number(bestAt.get(s.key).price));
  const baseline = earlier.length >= MIN_EARLIER_CHECKS ? median(earlier) : null;
  const change = baseline ? ((Number(best.price) - baseline) / baseline) * 100 : null;
  const previousLow = earlier.length ? Math.min(...earlier) : null;
  return { best, latest, baseline, change, earlierChecks: earlier.length, previousLow };
}

function statTiles(watch, s) {
  if (!s) return "";
  const seats = payingSeats(watch);
  const cur = watch.currency;
  const price = Number(s.best.price);
  const vsLow = s.previousLow
    ? (() => {
      const pct = ((price - s.previousLow) / s.previousLow) * 100;
      return pct <= -0.05 ? `new lowest (was ${money(s.previousLow, cur)})` : `lowest before: ${money(s.previousLow, cur)}`;
    })()
    : "";
  let changeTile;
  if (s.change === null) {
    changeTile = `<div class="stat"><span class="stat-label">vs recent checks</span>
      <span class="stat-value">–</span>
      <span class="stat-sub">Needs ${MIN_EARLIER_CHECKS} earlier checks (has ${s.earlierChecks})${vsLow ? ` · ${vsLow}` : ""}</span></div>`;
  } else {
    const down = s.change < 0;
    const cls = s.change <= -0.5 ? "delta-down" : s.change >= 0.5 ? "delta-up" : "";
    const arrow = s.change <= -0.5 ? "▼" : s.change >= 0.5 ? "▲" : "●";
    changeTile = `<div class="stat"><span class="stat-label">vs recent checks</span>
      <span class="stat-value ${cls}">${arrow} ${down ? "−" : "+"}${Math.abs(s.change).toFixed(1)}%</span>
      <span class="stat-sub">median ${money(s.baseline, cur)} of ${s.earlierChecks} earlier checks · ${vsLow}</span></div>`;
  }
  const total = groupTotal(s.best, watch);
  const level = s.best.price_level ? ` · Google: prices <b>${esc(s.best.price_level)}</b>` : "";
  return `<div class="stats">
    <div class="stat"><span class="stat-label">Cheapest now</span>
      <span class="stat-value">${money(price, cur)}</span>
      <span class="stat-sub">per person${seats > 1 ? ` · ${total.exact ? "" : "~"}${money(total.amount, cur)} for ${seats}` : ""}${level}</span></div>
    ${changeTile}
    <div class="stat"><span class="stat-label">Best dates</span>
      <span class="stat-value">${fmtShort(s.best.depart_date)} – ${fmtShort(s.best.return_date)}</span>
      <span class="stat-sub">${esc(s.best.origin)} → ${esc(s.best.destination)} · ${nightsBetween(s.best.depart_date, s.best.return_date)} nights${s.best.airline ? ` · ${esc(airlineName(s.best.airline))}` : ""} · ${sourceLabel(s.best.source)}</span></div>
  </div>`;
}

const sourceLabel = (source) => (source === "google" ? "Google Flights" : "Aviasales cache");

/** Google prices the whole group exactly; Aviasales is per adult, so its total is an estimate. */
function groupTotal(fare, watch) {
  if (fare.price_total) return { amount: Number(fare.price_total), exact: true };
  return { amount: Number(fare.price) * payingSeats(watch), exact: false };
}

/**
 * The 10 lowest fares seen across all checks, cheapest first. Identical fares (same route,
 * dates, airline, price and source) seen at several checks are one row with a first/last-seen
 * timeline, so a long-lasting fare doesn't fill the whole table.
 */
function lowestChecksTable(watch) {
  const { all, slots, sortKey } = chartPoints(watch);
  if (!all.length) return "";
  const seats = payingSeats(watch);
  const colors = airlineColors(watch, all);
  // "Now" = best fare at the most recent check.
  const latestKey = slots.at(-1).key;
  const current = all.filter((p) => sortKey(p) === latestKey)
    .reduce((a, b) => (!a || Number(b.price) < Number(a.price) ? b : a), null);

  const groups = new Map();
  for (const p of all) {
    const key = [p.origin, p.destination, p.depart_date, p.return_date, airlineName(p.airline), Number(p.price), p.source].join("|");
    const when = p.at ?? `${p.day}T12:00:00Z`;
    const g = groups.get(key);
    if (!g) groups.set(key, { p, first: p, last: p, firstAt: when, lastAt: when, checks: 1 });
    else {
      g.checks++;
      if (when < g.firstAt) Object.assign(g, { first: p, firstAt: when });
      if (when > g.lastAt) Object.assign(g, { last: p, lastAt: when });
    }
  }
  const rows = [...groups.values()]
    .sort((a, b) => Number(a.p.price) - Number(b.p.price) || a.firstAt.localeCompare(b.firstAt))
    .slice(0, 10);

  const whenText = (p) => p.at ? checkLabelFmt.format(new Date(p.at)) : `${dayLabelFmt.format(new Date(p.day))}`;
  const vsNow = (price) => {
    if (!current) return "";
    const pct = ((Number(price) - Number(current.price)) / Number(current.price)) * 100;
    if (Math.abs(pct) < 0.05) return `<span class="muted">= now</span>`;
    return pct < 0
      ? `<span class="delta-down">▼ ${Math.abs(pct).toFixed(1)}%</span>`
      : `<span class="delta-up">▲ ${pct.toFixed(1)}%</span>`;
  };

  const body = rows.map((g, i) => {
    const p = g.p;
    const total = groupTotal(p, watch);
    const name = airlineName(p.airline);
    return `<tr>
      <td class="num muted">${i + 1}</td>
      <td class="num"><b>${money(p.price, watch.currency)}</b></td>
      ${seats > 1 ? `<td class="num">${total.exact ? "" : "~"}${money(total.amount, watch.currency)}</td>` : ""}
      <td><span class="legend-item"><span class="swatch" style="background:${colors.get(name)}"></span>${esc(name)}</span></td>
      <td>${fmtShort(p.depart_date)} – ${fmtShort(p.return_date)} <span class="muted">(${nightsBetween(p.depart_date, p.return_date)} n)</span></td>
      <td>${esc(p.origin)} → ${esc(p.destination)}</td>
      <td>${g.checks > 1 ? `${whenText(g.first)} → ${whenText(g.last)}` : whenText(g.first)}</td>
      <td class="num">${g.checks}</td>
      <td>${sourceLabel(p.source)}${p.price_level ? ` <span class="muted">(${esc(p.price_level)})</span>` : ""}</td>
      <td>${vsNow(p.price)}</td>
    </tr>`;
  }).join("");

  return `<section class="lowest">
    <h3>Lowest prices seen <span class="muted small">(top 10, cheapest first)</span></h3>
    <div class="table-wrap"><table>
      <thead><tr><th class="num">#</th><th class="num">Per person</th>${seats > 1 ? `<th class="num">${seats} seats</th>` : ""}
        <th>Airline</th><th>Trip</th><th>Route</th><th>Seen (first → last check)</th><th class="num">Checks</th>
        <th>Source</th><th>vs now</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <p class="muted small">Each row is one fare. If the same flight and price was the best at several checks in a row, it appears once with when it was first and last seen. Times are Warsaw time.</p>
  </section>`;
}

const SLOT_LABELS = { morning: "Morning (07:17)", afternoon: "Afternoon (14:05)", evening: "Evening (20:05)" };

/**
 * "When are prices lowest?" Each observation is compared with the same flight's own average,
 * so the numbers show timing effects rather than differences between trips.
 */
function timingBlock(watch) {
  const t = data.timing?.[watch.id];
  const fmtDev = (v) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(1)}%`;
  const cell = (b, label) => `<span class="tchip${b.avgDeviationPct <= -0.5 ? " low" : ""}">
      ${esc(label)} <b>${fmtDev(b.avgDeviationPct)}</b> <span class="muted">(${b.observations})</span></span>`;

  if (!t || !t.observations) {
    return `<div class="timing"><b>When are prices lowest?</b>
      <span class="muted">Collecting data: each check records prices with its time. This needs about two weeks to be meaningful.</span></div>`;
  }
  const best = (list) => list.filter((b) => b.observations >= 3)
    .reduce((a, b) => (!a || b.avgDeviationPct < a.avgDeviationPct ? b : a), null);
  const bestSlot = best(t.bySlot);
  const bestDay = best(t.byWeekday);
  const headline = t.reliable && bestSlot
    ? `So far, prices are lowest in the <b>${esc(SLOT_LABELS[bestSlot.key].split(" (")[0].toLowerCase())}</b>`
      + (bestDay ? ` and on <b>${esc(bestDay.key)}</b>` : "") + "."
    : `<span class="muted">Early data: not enough yet to call a pattern (${t.observations} observations of ${t.itineraries} flights).</span>`;

  return `<div class="timing">
    <p><b>When are prices lowest?</b> ${headline}</p>
    <p class="tchips">${t.bySlot.map((b) => cell(b, SLOT_LABELS[b.key])).join("")}</p>
    ${t.byWeekday.length ? `<p class="tchips">${t.byWeekday.map((b) => cell(b, b.key)).join("")}</p>` : ""}
    <p class="muted small">Average price vs the same flight's own average, by check time and weekday (Warsaw time). Negative means cheaper. Number of observations in brackets.</p>
  </div>`;
}

function coverageLine(watch) {
  const g = data.google;
  if (!g?.enabled) return "";
  const c = g.coverage?.[watch.id];
  if (!c?.total) return "";
  return `<p class="coverage">Google Flights: ${c.checked} of ${c.total} date options checked in the last ${g.freshDays} days
    <span class="muted">(a few per day, cheapest re-checked daily)</span></p>`;
}

function watchCard(watch) {
  const s = summarize(watch);
  const back = watch.return_by ?? addDays(watch.depart_to, watch.stay_max);
  const criteria = [
    `<b>${esc(watch.origins.join(", "))} → ${esc(watch.destinations.join(", "))}</b>`,
    `${fmtDate(watch.depart_from)} – ${fmtDate(back)}`,
    `${watch.stay_min}–${watch.stay_max} nights`,
    stopsLabel(watch.max_transfers),
    watch.max_leg_minutes ? `≤ ${hours(watch.max_leg_minutes)} each way` : null,
    travellers(watch),
    `alert at −${Number(watch.drop_pct)}%`,
  ].filter(Boolean).map((c) => `<span>${c}</span>`).join("");

  const body = s
    ? `${statTiles(watch, s)}
       <p class="chart-title">Best fare per person at each check · hover a point for the check time and details</p>
       <div class="chart-wrap"><canvas aria-label="Price history chart for ${esc(watch.name)}" role="img"></canvas></div>
       <div class="airline-legend"></div>
       ${timingBlock(watch)}
       ${lowestChecksTable(watch)}
       <details class="trips"><summary>Latest known fares</summary><div class="trips-body"><p class="muted small">Loading…</p></div></details>`
    : `<div class="empty">No fares recorded yet. They appear after the next daily check, or click <b>Check prices now</b>.</div>`;

  return `<article class="card${watch.active ? "" : " inactive"}" data-id="${watch.id}">
    <header class="card-head">
      <div>
        <h2>${esc(watch.name)} ${watch.active ? "" : `<span class="pill">Paused</span>`}</h2>
        <p class="criteria">${criteria}</p>
        ${coverageLine(watch)}
      </div>
      <div class="card-actions">
        <button class="btn btn-small" data-action="diagnose" type="button" title="Run the searches live and show why fares are filtered out">Diagnose</button>
        <button class="btn btn-small" data-action="toggle" type="button">${watch.active ? "Pause" : "Resume"}</button>
        <button class="btn btn-small" data-action="edit" type="button">Edit</button>
        <button class="btn btn-small btn-ghost btn-danger" data-action="delete" type="button">Delete</button>
      </div>
    </header>
    <div class="diagnose" hidden></div>
    ${body}
  </article>`;
}

// Check times are shown in Warsaw time, matching the schedule.
const WARSAW = "Europe/Warsaw";
const checkLabelFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: WARSAW });
const checkTitleFmt = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: WARSAW });
const dayLabelFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const dayTitleFmt = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

/**
 * Chart points for a watch: one per check (with time) where recorded, plus one per day for
 * earlier days that only have the daily summary.
 */
function chartPoints(watch) {
  const points = (data.points ?? []).filter((p) => p.watch_id === watch.id)
    .map((p) => ({ ...p, at: p.checked_at, day: p.checked_at.slice(0, 10) }));
  const daysWithPoints = new Set(points.map((p) => p.day));
  const daily = data.daily.filter((r) => r.watch_id === watch.id && !daysWithPoints.has(r.checked_on))
    .map((r) => ({ ...r, at: null, day: r.checked_on }));
  const all = [...daily, ...points];
  const sortKey = (p) => p.at ?? `${p.day}T12:00:00Z`;
  // Distinct x positions: each check time, or each day without check times.
  const slots = [...new Map(all.map((p) => [sortKey(p), p])).values()]
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
    .map((p) => ({ key: sortKey(p), at: p.at, day: p.day }));
  return { all, slots, sortKey };
}

function renderChart(card, watch) {
  const canvas = $("canvas", card);
  if (!canvas || !window.Chart) return;
  const { all, slots, sortKey } = chartPoints(watch);
  const slotIndex = new Map(slots.map((s, i) => [s.key, i]));
  const routes = [...new Set(all.map((r) => `${r.origin} → ${r.destination}`))];
  // Color follows the route in the watch's own order, never its rank.
  const ordered = watch.destinations.flatMap((d) => watch.origins.map((o) => `${o} → ${d}`))
    .filter((r) => routes.includes(r))
    .concat(routes.filter((r) => !watch.destinations.some((d) => r.endsWith(d))));

  const seats = payingSeats(watch);
  const byAirline = colorMode(watch) === "airline";
  const airlineColor = airlineColors(watch, all);
  const neutral = cssVar("--text-3");
  const surface = cssVar("--surface");
  const DASHES = [[], [6, 4], [2, 3], [10, 3, 2, 3]]; // routes stay distinguishable in airline mode

  const datasets = ordered.map((route, i) => {
    const routeColor = cssVar(`--series-${(i % 8) + 1}`);
    const values = new Array(slots.length).fill(null);
    const meta = new Array(slots.length).fill(null);
    for (const p of all.filter((r) => `${r.origin} → ${r.destination}` === route)) {
      const idx = slotIndex.get(sortKey(p));
      if (values[idx] === null || Number(p.price) < values[idx]) {
        values[idx] = Number(p.price);
        meta[idx] = p;
      }
    }
    const pointColors = meta.map((p) => (p ? airlineColor.get(airlineName(p.airline)) : neutral));
    return {
      label: route,
      data: values,
      meta,
      borderColor: byAirline ? neutral : routeColor,
      backgroundColor: byAirline ? neutral : routeColor,
      borderDash: byAirline ? DASHES[i % DASHES.length] : [],
      borderWidth: 2,
      // Airline mode: every point shows, filled with the airline's color, with a surface ring.
      pointRadius: byAirline ? 4.5 : slots.length > 45 ? 0 : 3,
      pointHoverRadius: byAirline ? 6.5 : 5,
      pointBackgroundColor: byAirline ? pointColors : routeColor,
      pointBorderColor: surface,
      pointBorderWidth: 2,
      spanGaps: true,
      tension: 0.25,
    };
  });

  charts.get(watch.id)?.destroy();
  const text2 = cssVar("--text-2");
  const grid = cssVar("--grid");
  const labels = slots.map((s) => s.at ? checkLabelFmt.format(new Date(s.at)) : dayLabelFmt.format(new Date(s.day)));
  charts.set(watch.id, new Chart(canvas, {
    type: "line",
    data: { labels, datasets },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: datasets.length > 1,
          position: "top",
          align: "start",
          labels: { color: text2, boxWidth: 12, boxHeight: 2, usePointStyle: false },
        },
        tooltip: {
          padding: 10,
          callbacks: {
            labelColor: (ctx) => {
              const p = ctx.dataset.meta[ctx.dataIndex];
              const c = byAirline && p ? airlineColor.get(airlineName(p.airline)) : ctx.dataset.borderColor;
              return { borderColor: c, backgroundColor: c };
            },
            title: (items) => {
              const s = slots[items[0].dataIndex];
              return s.at
                ? `Check on ${checkTitleFmt.format(new Date(s.at))} (Warsaw time)`
                : `${dayTitleFmt.format(new Date(s.day))} (daily summary, time not recorded)`;
            },
            label: (ctx) => {
              if (ctx.parsed.y == null) return null;
              const p = ctx.dataset.meta[ctx.dataIndex];
              const total = groupTotal(p, watch);
              return ` ${ctx.dataset.label}: ${money(ctx.parsed.y, watch.currency)} / person`
                + (seats > 1 ? ` · ${total.exact ? "" : "~"}${money(total.amount, watch.currency)} for ${seats}` : "");
            },
            afterLabel: (ctx) => {
              const p = ctx.dataset.meta[ctx.dataIndex];
              if (!p) return "";
              return `   ${fmtShort(p.depart_date)} – ${fmtShort(p.return_date)} · ${airlineName(p.airline)}`
                + ` · ${sourceLabel(p.source)}${p.price_level ? ` (prices ${p.price_level})` : ""}`;
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: text2, maxRotation: 0, autoSkipPadding: 16 }, border: { color: grid } },
        y: {
          grid: { color: grid },
          border: { display: false },
          ticks: { color: text2, callback: (v) => `${Number(v).toLocaleString("en-GB")}` },
          title: { display: true, text: `${watch.currency} / person`, color: text2 },
        },
      },
    },
  }));

  renderAirlineLegend(card, watch, datasets, airlineColor, byAirline);
}

// ---------- airline colors ----------

// Aviasales reports IATA codes, Google reports names: map codes so one airline gets one color.
const AIRLINE_CODES = {
  LO: "LOT", KL: "KLM", SK: "SAS", A3: "Aegean", FR: "Ryanair", W6: "Wizz Air", W4: "Wizz Air",
  LH: "Lufthansa", OS: "Austrian", LX: "Swiss", SN: "Brussels Airlines", AF: "Air France",
  U2: "easyJet", EW: "Eurowings", DY: "Norwegian", D8: "Norwegian", TK: "Turkish Airlines",
  BA: "British Airways", IB: "Iberia", VY: "Vueling", AZ: "ITA Airways", TP: "TAP Air Portugal",
  OA: "Olympic Air", LY: "El Al", EK: "Emirates", QR: "Qatar Airways", AY: "Finnair", BT: "airBaltic",
};

function airlineName(raw) {
  if (!raw) return "Unknown";
  return String(raw).split(/\s*\+\s*/).map((a) => AIRLINE_CODES[a.trim()] ?? a.trim()).join(" + ");
}

/**
 * Airline → color. Slots are handed out in order of first appearance over time, so an airline
 * keeps its color as new ones show up (color follows the entity, never its rank). Past the
 * eight palette slots, airlines share the neutral "other" color.
 */
function airlineColors(watch, points) {
  const order = [];
  for (const p of [...points].sort((a, b) => (a.at ?? a.day).localeCompare(b.at ?? b.day))) {
    const name = airlineName(p.airline);
    if (!order.includes(name)) order.push(name);
  }
  return new Map(order.map((name, i) => [name, i < 8 ? cssVar(`--series-${i + 1}`) : cssVar("--text-3")]));
}

const COLOR_MODE_KEY = "flight-watcher-color-mode";
function colorMode(watch) {
  try { return JSON.parse(localStorage.getItem(COLOR_MODE_KEY) ?? "{}")[watch.id] ?? "airline"; } catch { return "airline"; }
}
function setColorMode(watch, mode) {
  try {
    const all = JSON.parse(localStorage.getItem(COLOR_MODE_KEY) ?? "{}");
    all[watch.id] = mode;
    localStorage.setItem(COLOR_MODE_KEY, JSON.stringify(all));
  } catch { /* private mode: falls back to the default */ }
}

/** Legend under the chart: each airline's color and how often it had the lowest fare. */
function renderAirlineLegend(card, watch, datasets, airlineColor, byAirline) {
  const el = $(".airline-legend", card);
  if (!el) return;
  const toggle = `<span class="seg" role="group" aria-label="Color points by">
      <button type="button" data-mode="airline" aria-pressed="${byAirline}">Airline</button>
      <button type="button" data-mode="route" aria-pressed="${!byAirline}">Route</button>
    </span>`;

  // Which airline had the lowest fare at each check (across routes)?
  const wins = new Map();
  let checks = 0;
  const n = datasets[0]?.data.length ?? 0;
  for (let i = 0; i < n; i++) {
    let best = null;
    for (const ds of datasets) {
      const p = ds.meta[i];
      if (p && (!best || Number(p.price) < Number(best.price))) best = p;
    }
    if (!best) continue;
    checks++;
    const name = airlineName(best.airline);
    wins.set(name, (wins.get(name) ?? 0) + 1);
  }

  const items = [...airlineColor.keys()].map((name) => `<span class="legend-item">
      <span class="swatch" style="background:${airlineColor.get(name)}"></span>${esc(name)}
      <span class="muted">lowest at ${wins.get(name) ?? 0} of ${checks} check${checks === 1 ? "" : "s"}</span></span>`).join("");

  el.innerHTML = `<div class="legend-row"><span class="muted small">Color points by</span> ${toggle}</div>
    ${byAirline ? `<div class="legend-row">${items}</div>` : ""}`;
  el.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
    setColorMode(watch, b.dataset.mode);
    renderChart(card, watch);
  }));
}

function renderAlerts() {
  const el = $("#alerts");
  if (!data.alerts.length) {
    el.innerHTML = `<p class="muted small">No alerts yet. You'll get an email and see it here when a price drops.</p>`;
    return;
  }
  const names = new Map(data.watches.map((w) => [w.id, w.name]));
  el.innerHTML = data.alerts.map((a) => `<div class="alert-row">
      <span><b>${esc(a.origin)} → ${esc(a.destination)}</b> · ${fmtShort(a.depart_date)} – ${fmtShort(a.return_date)}
        <span class="muted">· ${esc(names.get(a.watch_id) ?? "")}</span></span>
      <span><b>${money(a.price, a.currency)}</b> <span class="delta-down">▼ −${Number(a.drop_pct)}%</span>
        <span class="muted small">· ${fmtDate(a.sent_at.slice(0, 10))}</span></span>
    </div>`).join("");
}

function render() {
  const container = $("#watches");
  for (const chart of charts.values()) chart.destroy();
  charts.clear();

  if (!data.watches.length) {
    container.innerHTML = `<div class="card"><div class="empty">No watches yet. Click <b>+ New watch</b> to start tracking a trip.</div></div>`;
  } else {
    container.innerHTML = data.watches.map(watchCard).join("");
    for (const watch of data.watches) {
      const card = container.querySelector(`[data-id="${watch.id}"]`);
      if (summarize(watch)) renderChart(card, watch);
    }
  }
  renderAlerts();

  renderStatus();
}

const timeFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Last check, today's Google budget and the schedule, so it's clear what ran and what will. */
function renderStatus() {
  const el = $("#status");
  const g = data.google ?? {};
  const last = data.runs?.[0];
  const lines = [];

  if (last) {
    const when = timeFmt.format(new Date(last.started_at));
    const how = last.trigger === "manual" ? "manual" : "scheduled";
    let result;
    if (last.failed) result = `<span class="error">failed: ${esc(last.failed)}</span>`;
    else if (!last.finished_at) result = "still running…";
    else {
      const errs = Array.isArray(last.errors) ? last.errors.length : 0;
      result = `${last.google_searches ?? 0} Google search${last.google_searches === 1 ? "" : "es"}, `
        + `${last.fares ?? 0} matching fares${errs ? `, <span class="error">${errs} error(s)</span>` : ""}`;
    }
    lines.push(`<b>Last check:</b> ${when} (${how}): ${result}`);
  } else {
    lines.push(`<b>Last check:</b> none recorded yet`);
  }

  if (g.enabled) {
    const left = Math.max(0, (g.dailyLimit ?? 3) - (g.searchesToday ?? 0));
    lines.push(`<b>Google today:</b> ${g.searchesToday ?? 0} of ${g.dailyLimit ?? 3} searches used`
      + (left ? ` (${left} left: each check, scheduled or “Check prices now”, uses 1)` : ", more tomorrow")
      + (g.account?.searchesLeft != null ? ` · ${g.account.searchesLeft} left this month` : ""));
  }
  lines.push(`<b>Schedule:</b> automatic checks daily at 07:17, 14:05 and 20:05 (Warsaw time), 1 Google search each · weekly summary Sundays 18:03`);

  el.innerHTML = lines.map((l) => `<p>${l}</p>`).join("") + checkHistory();
  el.hidden = false;
}

/** Every recent check (scheduled or manual) with what it found. */
function checkHistory() {
  const runs = data.runs ?? [];
  if (!runs.length) return "";
  const bestByRun = new Map();
  for (const p of data.points ?? []) {
    if (p.run_id == null) continue;
    const cur = bestByRun.get(p.run_id);
    if (!cur || Number(p.price) < Number(cur.price)) bestByRun.set(p.run_id, p);
  }
  const watchById = new Map(data.watches.map((w) => [w.id, w]));
  const rows = runs.map((r) => {
    const best = bestByRun.get(r.id);
    const w = best && watchById.get(best.watch_id);
    const errs = Array.isArray(r.errors) ? r.errors.length : 0;
    const status = r.failed ? `<span class="error">failed</span>`
      : !r.finished_at ? "running…"
      : errs ? `<span class="error">${errs} error(s)</span>` : "ok";
    return `<tr>
      <td>${esc(checkLabelFmt.format(new Date(r.started_at)))}</td>
      <td>${r.trigger === "manual" ? "manual" : "scheduled"}</td>
      <td class="num">${r.google_searches ?? "–"}</td>
      <td class="num">${r.fares ?? "–"}</td>
      <td class="num">${best ? `<b>${money(best.price, w?.currency ?? "")}</b>` : "–"}</td>
      <td>${best ? `${esc(airlineName(best.airline))} · ${fmtShort(best.depart_date)} – ${fmtShort(best.return_date)}` : ""}</td>
      <td class="num">${r.alerts_sent ?? 0}</td>
      <td>${status}</td>
    </tr>`;
  }).join("");
  return `<details class="history"><summary>All checks (last ${runs.length})</summary>
    <div class="table-wrap"><table>
      <thead><tr><th>When (Warsaw)</th><th>Type</th><th class="num">Google searches</th><th class="num">Fares</th>
        <th class="num">Best / person</th><th>Best fare</th><th class="num">Alerts</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div></details>`;
}

async function loadTrips(card, watch) {
  const body = $(".trips-body", card);
  try {
    const { trips } = await api("GET", `/watches/${watch.id}/trips`);
    if (!trips.length) {
      body.innerHTML = `<p class="muted small">No matching fares yet.</p>`;
      return;
    }
    const seats = payingSeats(watch);
    body.innerHTML = `<p class="muted small">Latest price for each date option: Aviasales from the last check, Google Flights from the last ${data.google?.freshDays ?? 12} days.
        Totals marked ~ are estimates (per-adult fare × seats). Confirm on the airline site before booking.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Route</th><th>Dates</th><th class="num">Nights</th><th>Airline</th><th>Stops</th>
          <th>Journey out</th><th class="num">Per person</th>${seats > 1 ? `<th class="num">${seats} seats</th>` : ""}
          <th>Source</th><th>Checked</th><th></th></tr></thead>
        <tbody>${trips.map((t) => {
          const total = groupTotal(t, watch);
          return `<tr>
          <td>${esc(t.origin)} → ${esc(t.destination)}</td>
          <td>${fmtShort(t.depart_date)} – ${fmtShort(t.return_date)}</td>
          <td class="num">${nightsBetween(t.depart_date, t.return_date)}</td>
          <td>${t.airline ? esc(airlineName(t.airline)) : ""}</td>
          <td>${t.transfers ? `≤ ${t.transfers}` : "Direct"}</td>
          <td>${hours(t.duration_to)}</td>
          <td class="num"><b>${money(t.price, t.currency)}</b></td>
          ${seats > 1 ? `<td class="num">${total.exact ? "" : "~"}${money(total.amount, t.currency)}</td>` : ""}
          <td>${sourceLabel(t.source)}${t.price_level ? ` <span class="muted">(${esc(t.price_level)})</span>` : ""}</td>
          <td>${fmtShort(t.checked_on)}</td>
          <td>${t.link ? `<a href="${esc(t.link)}" target="_blank" rel="noopener">View</a>` : ""}</td>
        </tr>`;
        }).join("")}</tbody>
      </table></div>`;
  } catch (err) {
    body.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

// ---------- diagnose ----------

const REJECT_LABELS = {
  "no-return-flight": "no return flight",
  "outside-departure-window": "departure outside window",
  "back-too-late": "back after “back by”",
  "stay-length": "wrong number of nights",
  "too-many-stops": "too many stops",
  "journey-too-long-or-unknown": "journey too long / time unknown",
};

const rejectedText = (rejected) =>
  Object.entries(rejected ?? {}).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${REJECT_LABELS[k] ?? k}`).join(", ") || "–";

async function runDiagnose(card, watch, button) {
  const panel = $(".diagnose", card);
  panel.hidden = false;
  panel.innerHTML = `<p class="muted small">Running live searches… this can take up to a minute.</p>`;
  button.disabled = true;
  try {
    const result = DEMO
      ? (() => { throw new Error("Demo mode: diagnose needs the real API."); })()
      : await api("GET", `/watches/${watch.id}/diagnose`);
    const rows = result.searches.map((s) => s.error
      ? `<tr><td>${esc(s.origin)} → ${esc(s.destination)}</td><td>${esc(s.month)}</td><td colspan="4" class="error">${esc(s.error)}</td></tr>`
      : `<tr>
          <td>${esc(s.origin)} → ${esc(s.destination)}</td>
          <td>${esc(s.month)}</td>
          <td class="num">${s.roundTrip.fares}</td>
          <td class="num"><b>${s.roundTrip.matching}</b></td>
          <td class="wrap">${esc(rejectedText(s.roundTrip.rejected))}</td>
          <td class="num">${s.oneWayOutbound.fares}</td>
        </tr>`).join("");
    const json = JSON.stringify(result, null, 2);
    const probeRows = (result.probes ?? []).map((p) => `<tr>
        <td class="wrap">${esc(p.label)}</td>
        <td class="num">${p.error ? `<span class="error">${esc(p.error)}</span>` : `<b>${p.fares}</b>`}</td>
        <td>${p.cheapest?.[0] ? `${money(p.cheapest[0].price, watch.currency)} · ${esc(String(p.cheapest[0].departure_at).slice(0, 10))}` : ""}</td>
      </tr>`).join("");
    panel.innerHTML = `<h3>Diagnosis <span class="muted small">(live, nothing saved)</span></h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Route</th><th>Month</th><th class="num">Round-trip fares from source</th><th class="num">Matching</th>
          <th>Dropped because</th><th class="num">One-way fares (any stops)</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      ${probeRows ? `<h3>Data-source checks</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Probe</th><th class="num">Fares</th><th>Cheapest</th></tr></thead>
        <tbody>${probeRows}</tbody>
      </table></div>` : ""}
      <h3>Google Flights searches so far</h3>
      ${result.googleLog?.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Searched on</th><th>Dates</th><th class="num">Fares kept</th><th>Error</th></tr></thead>
        <tbody>${result.googleLog.map((g) => `<tr>
          <td>${fmtShort(g.checked_on)}</td>
          <td>${fmtShort(g.depart_date)} – ${fmtShort(g.return_date)}</td>
          <td class="num">${g.results}</td>
          <td class="wrap">${g.error ? `<span class="error">${esc(g.error)}</span>` : ""}</td>
        </tr>`).join("")}</tbody></table></div>`
        : `<p class="muted small">None yet. They run with each price check (3 per day).</p>`}
      <h3>Test a Google search</h3>
      <form class="google-test">
        <label class="field">Depart <input type="date" name="depart" required value="${esc(watch.depart_from)}"></label>
        <label class="field">Return <input type="date" name="ret" required value="${esc(addDays(watch.depart_from, watch.stay_min))}"></label>
        <label class="check"><input type="checkbox" name="filters" checked> Apply the watch's stop and journey-time limits</label>
        <button class="btn btn-small btn-primary" type="submit">Search (uses 1 of your searches)</button>
      </form>
      <div class="google-test-result"></div>
      <details><summary class="small">Raw details</summary>
        <button class="btn btn-small" type="button" data-copy>Copy</button>
        <pre>${esc(json)}</pre></details>
      <button class="btn btn-small btn-ghost" type="button" data-close>Close</button>`;
    $("[data-copy]", panel).addEventListener("click", () => {
      navigator.clipboard?.writeText(json).then(() => toast("Copied"), () => toast("Copy failed"));
    });
    $("[data-close]", panel).addEventListener("click", () => { panel.hidden = true; });
    $(".google-test", panel).addEventListener("submit", (e) => {
      e.preventDefault();
      runGoogleTest(e.currentTarget, $(".google-test-result", panel), watch);
    });
  } catch (err) {
    panel.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  } finally {
    button.disabled = false;
  }
}

async function runGoogleTest(form, out, watch) {
  const f = form.elements;
  const button = $("button", form);
  button.disabled = true;
  out.innerHTML = `<p class="muted small">Searching Google Flights…</p>`;
  try {
    const r = await api("POST", `/watches/${watch.id}/google-test`, {
      depart: f.depart.value, ret: f.ret.value, filters: f.filters.checked,
    });
    const rows = r.itineraries.map((it) => `<tr>
        <td class="num">${it.price == null ? "–" : money(it.price, watch.currency)}</td>
        <td>${esc(it.airlines)}</td>
        <td>${it.transfers ? `${it.transfers} (${esc(it.via)})` : "Direct"}</td>
        <td>${hours(it.totalDuration)}</td>
        <td>${it.kept ? "✔ kept" : `✖ ${esc(it.reason)}`}</td>
      </tr>`).join("");
    out.innerHTML = `${r.error ? `<p class="error">${esc(r.error)}</p>` : ""}
      <p class="small">${r.itineraries.length} itineraries from Google, ${r.fares.length} kept
        ${r.priceLevel ? ` · Google says prices are <b>${esc(r.priceLevel)}</b>` : ""}.
        Prices are the round-trip total for your group.</p>
      ${rows ? `<div class="table-wrap"><table>
        <thead><tr><th class="num">Total</th><th>Airlines</th><th>Stops</th><th>Outbound time</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : ""}
      <details><summary class="small">Request sent</summary><pre>${esc(JSON.stringify(r.request, null, 2))}</pre></details>`;
    if (r.fares.length) toast("Result saved. It will appear on the card after the next refresh.");
  } catch (err) {
    out.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  } finally {
    button.disabled = false;
  }
}

// ---------- card actions ----------

$("#watches").addEventListener("click", async (e) => {
  const button = e.target.closest("button[data-action]");
  if (!button) return;
  const card = button.closest(".card");
  const watch = data.watches.find((w) => w.id === Number(card.dataset.id));
  const action = button.dataset.action;

  try {
    if (action === "edit") return openForm(watch);
    if (action === "diagnose") return runDiagnose(card, watch, button);
    if (action === "toggle") {
      await api("PATCH", `/watches/${watch.id}`, { active: !watch.active });
      toast(watch.active ? "Watch paused" : "Watch resumed");
    }
    if (action === "delete") {
      if (!confirm(`Delete "${watch.name}" and all its price history?`)) return;
      await api("DELETE", `/watches/${watch.id}`);
      toast("Watch deleted");
    }
    await refresh();
  } catch (err) {
    toast(err.message);
  }
});

$("#watches").addEventListener("toggle", (e) => {
  const details = e.target;
  if (!details.matches?.("details.trips") || !details.open || details.dataset.loaded) return;
  details.dataset.loaded = "1";
  const card = details.closest(".card");
  loadTrips(card, data.watches.find((w) => w.id === Number(card.dataset.id)));
}, true);

// ---------- watch form ----------

const dialog = $("#watch-dialog");
const form = $("#watch-form");
let editingId = null;

function openForm(watch) {
  editingId = watch?.id ?? null;
  form.reset();
  $("#watch-form-error").hidden = true;
  $("#watch-form-title").textContent = watch ? `Edit "${watch.name}"` : "New watch";
  if (watch) {
    const f = form.elements;
    f.name.value = watch.name;
    f.origins.value = watch.origins.join(", ");
    f.destinations.value = watch.destinations.join(", ");
    f.depart_from.value = watch.depart_from;
    f.return_by.value = watch.return_by ?? addDays(watch.depart_to, watch.stay_max);
    f.stay_min.value = watch.stay_min;
    f.stay_max.value = watch.stay_max;
    f.max_transfers.value = String(watch.max_transfers);
    f.max_leg_hours.value = watch.max_leg_minutes ? watch.max_leg_minutes / 60 : "";
    f.adults.value = watch.adults;
    f.child_ages.value = (watch.child_ages ?? []).join(", ");
    f.drop_pct.value = Number(watch.drop_pct);
    f.currency.value = watch.currency;
  }
  dialog.showModal();
}

function readForm() {
  const f = form.elements;
  const list = (v) => v.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const origins = list(f.origins.value);
  const destinations = list(f.destinations.value);
  const bad = [...origins, ...destinations].filter((c) => !/^[A-Z]{3}$/.test(c));
  if (bad.length) throw new Error(`Not a 3-letter airport/city code: ${bad.join(", ")}`);

  const stayMin = Number(f.stay_min.value);
  const stayMax = Number(f.stay_max.value);
  if (stayMax < stayMin) throw new Error("Max nights must be at least min nights.");

  const departFrom = f.depart_from.value;
  const returnBy = f.return_by.value;
  // Latest departure that still allows the shortest stay before the "back by" date
  const departTo = addDays(returnBy, -stayMin);
  if (departTo < departFrom) throw new Error("The travel window is shorter than the minimum stay.");

  const childAges = f.child_ages.value.trim()
    ? f.child_ages.value.split(/[\s,;]+/).filter(Boolean).map(Number)
    : [];
  if (childAges.some((a) => !Number.isInteger(a) || a < 0 || a > 17)) throw new Error("Children's ages should be whole numbers 0–17.");

  const legHours = f.max_leg_hours.value ? Number(f.max_leg_hours.value) : null;

  return {
    name: f.name.value.trim(),
    origins,
    destinations,
    depart_from: departFrom,
    depart_to: departTo,
    return_by: returnBy,
    stay_min: stayMin,
    stay_max: stayMax,
    max_transfers: Number(f.max_transfers.value),
    max_leg_minutes: legHours ? Math.round(legHours * 60) : null,
    adults: Number(f.adults.value),
    child_ages: childAges,
    drop_pct: Number(f.drop_pct.value),
    currency: f.currency.value,
  };
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = $("#watch-form-error");
  errorEl.hidden = true;
  const save = $("#watch-save");
  try {
    const body = readForm();
    save.disabled = true;
    if (editingId) await api("PATCH", `/watches/${editingId}`, body);
    else await api("POST", "/watches", body);
    dialog.close();
    toast(editingId ? "Watch updated" : "Watch created. Click “Check prices now” to fetch fares.");
    await refresh();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    save.disabled = false;
  }
});

$("#watch-cancel").addEventListener("click", () => dialog.close());
$("#btn-new").addEventListener("click", () => openForm(null));

// ---------- check now ----------

$("#btn-check").addEventListener("click", async (e) => {
  const button = e.currentTarget;
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    const result = await api("POST", "/check");
    const sum = (key) => (result.watches ?? []).reduce((n, w) => n + (w[key] ?? 0), 0);
    const googleSearches = (result.watches ?? []).reduce((n, w) => n + (w.google?.searches ?? 0), 0);
    let msg = `Checked ${result.watches?.length ?? 0} watch(es): ${sum("fares")} matching fares `
      + `(${googleSearches} Google search${googleSearches === 1 ? "" : "es"}), ${result.alertsSent} alert(s) sent.`;
    if (googleSearches === 0) msg += " Today's Google searches are used up; more tomorrow.";
    if (sum("fares") === 0) msg += " Use Diagnose on a watch to see why.";
    if (result.errors?.length) msg += ` ${result.errors.length} search error(s): ${result.errors[0]}`;
    toast(msg, 10000);
    await refresh();
  } catch (err) {
    toast(`Check failed: ${err.message}`, 10000);
  } finally {
    button.disabled = false;
    button.textContent = "Check prices now";
  }
});

// ---------- test email ----------

$("#btn-test-email").addEventListener("click", async (e) => {
  const button = e.currentTarget;
  button.disabled = true;
  try {
    if (DEMO) throw new Error("Demo mode: sign in to send a test email.");
    const r = await api("POST", "/test-email");
    toast(`Test email sent to ${r.to.join(", ")}. Check your inbox (and spam).`, 8000);
  } catch (err) {
    toast(`Test email failed: ${err.message}`, 10000);
  } finally {
    button.disabled = false;
  }
});

$("#btn-digest").addEventListener("click", async (e) => {
  const button = e.currentTarget;
  button.disabled = true;
  try {
    if (DEMO) throw new Error("Demo mode: sign in to send the weekly summary.");
    const r = await api("POST", "/digest");
    toast(`Weekly summary sent to ${r.to.join(", ")} (${r.watches} watch${r.watches === 1 ? "" : "es"}).`, 8000);
  } catch (err) {
    toast(`Weekly summary failed: ${err.message}`, 10000);
  } finally {
    button.disabled = false;
  }
});

// ---------- boot ----------

async function refresh() {
  data = await api("GET", "/overview");
  render();
}

async function start() {
  $("#login").hidden = true;
  $("#app").hidden = false;
  $("#topbar-actions").hidden = false;
  try {
    await refresh();
  } catch (err) {
    $("#watches").innerHTML = `<div class="card"><p class="error">Could not load data: ${esc(err.message)}</p></div>`;
  }
}

// Redraw charts when the OS theme changes so they pick up the new colors.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => render());

if (DEMO) {
  $("#demo-banner").hidden = false;
  $("#btn-logout").hidden = true;
  start();
} else if (password) {
  start();
} else {
  showLogin();
}

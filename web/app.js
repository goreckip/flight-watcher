import { demoApi } from "./demo.js";

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

/** Summary numbers for one watch, from the per-route daily cheapest fares. */
function summarize(watch) {
  const rows = data.daily.filter((r) => r.watch_id === watch.id);
  if (!rows.length) return null;

  // Cheapest across all routes, per day
  const byDay = new Map();
  for (const r of rows) {
    const cur = byDay.get(r.checked_on);
    if (!cur || Number(r.price) < Number(cur.price)) byDay.set(r.checked_on, r);
  }
  const days = [...byDay.keys()].sort();
  const lastDay = days.at(-1);
  const best = byDay.get(lastDay);
  const baselineDays = days.filter((d) => d < lastDay && d >= addDays(lastDay, -BASELINE_DAYS));
  const baseline = baselineDays.length ? median(baselineDays.map((d) => Number(byDay.get(d).price))) : null;
  const change = baseline ? ((Number(best.price) - baseline) / baseline) * 100 : null;
  return { rows, lastDay, best, baseline, change, historyDays: baselineDays.length };
}

function statTiles(watch, s) {
  if (!s) return "";
  const seats = payingSeats(watch);
  const cur = watch.currency;
  const price = Number(s.best.price);
  let changeTile;
  if (s.change === null) {
    changeTile = `<div class="stat"><span class="stat-label">vs ${BASELINE_DAYS}-day median</span>
      <span class="stat-value">–</span><span class="stat-sub">Building history (needs 3 days)</span></div>`;
  } else {
    const down = s.change < 0;
    const cls = s.change <= -0.5 ? "delta-down" : s.change >= 0.5 ? "delta-up" : "";
    const arrow = s.change <= -0.5 ? "▼" : s.change >= 0.5 ? "▲" : "●";
    changeTile = `<div class="stat"><span class="stat-label">vs ${BASELINE_DAYS}-day median</span>
      <span class="stat-value ${cls}">${arrow} ${down ? "−" : "+"}${Math.abs(s.change).toFixed(1)}%</span>
      <span class="stat-sub">median ${money(s.baseline, cur)} · ${s.historyDays} day${s.historyDays === 1 ? "" : "s"} of history</span></div>`;
  }
  return `<div class="stats">
    <div class="stat"><span class="stat-label">Cheapest now</span>
      <span class="stat-value">${money(price, cur)}</span>
      <span class="stat-sub">per person${seats > 1 ? ` · ~${money(price * seats, cur)} for ${seats}` : ""}</span></div>
    ${changeTile}
    <div class="stat"><span class="stat-label">Best dates</span>
      <span class="stat-value">${fmtShort(s.best.depart_date)} – ${fmtShort(s.best.return_date)}</span>
      <span class="stat-sub">${esc(s.best.origin)} → ${esc(s.best.destination)} · ${nightsBetween(s.best.depart_date, s.best.return_date)} nights${s.best.airline ? ` · ${esc(s.best.airline)}` : ""}</span></div>
  </div>`;
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
       <p class="chart-title">Cheapest fare per person, by day of check${s.lastDay ? ` · last checked ${fmtDate(s.lastDay)}` : ""}</p>
       <div class="chart-wrap"><canvas aria-label="Price history chart for ${esc(watch.name)}" role="img"></canvas></div>
       <details class="trips"><summary>Cheapest trips from the last check</summary><div class="trips-body"><p class="muted small">Loading…</p></div></details>`
    : `<div class="empty">No fares recorded yet. They appear after the next daily check, or click <b>Check prices now</b>.</div>`;

  return `<article class="card${watch.active ? "" : " inactive"}" data-id="${watch.id}">
    <header class="card-head">
      <div>
        <h2>${esc(watch.name)} ${watch.active ? "" : `<span class="pill">Paused</span>`}</h2>
        <p class="criteria">${criteria}</p>
      </div>
      <div class="card-actions">
        <button class="btn btn-small" data-action="toggle" type="button">${watch.active ? "Pause" : "Resume"}</button>
        <button class="btn btn-small" data-action="edit" type="button">Edit</button>
        <button class="btn btn-small btn-ghost btn-danger" data-action="delete" type="button">Delete</button>
      </div>
    </header>
    ${body}
  </article>`;
}

function renderChart(card, watch) {
  const canvas = $("canvas", card);
  if (!canvas || !window.Chart) return;
  const s = summarize(watch);
  const days = [...new Set(s.rows.map((r) => r.checked_on))].sort();
  const routes = [...new Set(s.rows.map((r) => `${r.origin} → ${r.destination}`))];
  // Color follows the route in the watch's own order, never its rank.
  const ordered = watch.destinations.flatMap((d) => watch.origins.map((o) => `${o} → ${d}`))
    .filter((r) => routes.includes(r))
    .concat(routes.filter((r) => !watch.destinations.some((d) => r.endsWith(d))));

  const datasets = ordered.map((route, i) => {
    const color = cssVar(`--series-${(i % 8) + 1}`);
    const byDay = new Map(s.rows.filter((r) => `${r.origin} → ${r.destination}` === route)
      .map((r) => [r.checked_on, Number(r.price)]));
    return {
      label: route,
      data: days.map((d) => byDay.get(d) ?? null),
      borderColor: color,
      backgroundColor: color,
      borderWidth: 2,
      pointRadius: days.length > 30 ? 0 : 3,
      pointHoverRadius: 5,
      pointBorderColor: cssVar("--surface"),
      pointBorderWidth: 1.5,
      spanGaps: true,
      tension: 0.25,
    };
  });

  charts.get(watch.id)?.destroy();
  const text2 = cssVar("--text-2");
  const grid = cssVar("--grid");
  charts.set(watch.id, new Chart(canvas, {
    type: "line",
    data: { labels: days.map(fmtShort), datasets },
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
          callbacks: {
            label: (ctx) => ctx.parsed.y == null ? null
              : ` ${ctx.dataset.label}: ${money(ctx.parsed.y, watch.currency)}`
                + (payingSeats(watch) > 1 ? ` (~${money(ctx.parsed.y * payingSeats(watch), watch.currency)} total)` : ""),
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
}

async function loadTrips(card, watch) {
  const body = $(".trips-body", card);
  try {
    const { checked_on, trips } = await api("GET", `/watches/${watch.id}/trips`);
    if (!trips.length) {
      body.innerHTML = `<p class="muted small">No matching fares in the last check.</p>`;
      return;
    }
    const seats = payingSeats(watch);
    body.innerHTML = `<p class="muted small">From the check on ${fmtDate(checked_on)}. Prices are cached, so confirm on the airline site.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Route</th><th>Dates</th><th class="num">Nights</th><th>Airline</th><th>Stops</th>
          <th>Journey (out / back)</th><th class="num">Per person</th>${seats > 1 ? `<th class="num">~ ${seats} seats</th>` : ""}<th></th></tr></thead>
        <tbody>${trips.map((t) => `<tr>
          <td>${esc(t.origin)} → ${esc(t.destination)}</td>
          <td>${fmtShort(t.depart_date)} – ${fmtShort(t.return_date)}</td>
          <td class="num">${nightsBetween(t.depart_date, t.return_date)}</td>
          <td>${esc(t.airline ?? "")}</td>
          <td>${t.transfers ? `≤ ${t.transfers}` : "Direct"}</td>
          <td>${hours(t.duration_to)} / ${hours(t.duration_back)}</td>
          <td class="num"><b>${money(t.price, t.currency)}</b></td>
          ${seats > 1 ? `<td class="num">${money(t.price * seats, t.currency)}</td>` : ""}
          <td>${t.link ? `<a href="${esc(t.link)}" target="_blank" rel="noopener">View</a>` : ""}</td>
        </tr>`).join("")}</tbody>
      </table></div>`;
  } catch (err) {
    body.innerHTML = `<p class="error">${esc(err.message)}</p>`;
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
    const fares = (result.watches ?? []).reduce((n, w) => n + (w.fares ?? 0), 0);
    let msg = `Checked ${result.watches?.length ?? 0} watch(es): ${fares} matching fares, ${result.alertsSent} alert(s) sent.`;
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

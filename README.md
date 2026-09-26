# Flight Watcher

A personal agent that checks flight prices every day, tracks the trend, and emails you when a fare drops.

**Dashboard:** https://goreckip.github.io/flight-watcher/ · [demo with sample data](https://goreckip.github.io/flight-watcher/?demo)

## What it does

- Monitors "watches": origins, destinations, a travel window (leave on or after / back by), a stay length, max stops, max journey time per direction, and who's travelling (for a family price estimate)
- Stores daily price snapshots and charts the cheapest fare per route over time
- Emails an alert when a price drops more than your threshold (e.g. 10%) below its recent median
- A password-protected web dashboard to add, edit, pause and delete watches, view price history, and run a check on demand

## Stack (free tiers)

| Part | Tool |
|---|---|
| Database | Supabase Postgres |
| Backend | Supabase Edge Functions (Deno / TypeScript) |
| Dashboard | Static HTML/JS + Chart.js on GitHub Pages |
| Scheduler | Supabase pg_cron + pg_net: checks 07:17 / 14:05 / 20:05 and Sunday summary 18:03, Warsaw time |
| Flight prices | Travelpayouts Data API (cached, broad) + Google Flights via SerpApi (live, exact dates, 100 free searches/month) |
| Email | Resend |

## Architecture

```
GitHub Actions (daily)             Dashboard (GitHub Pages)
        │  POST + CRON_SECRET              │  x-app-password
        ▼                                  ▼
Edge Function "check-prices"  ◄───  Edge Function "api"
   1. load active watches               watches CRUD, overview,
   2. build search plan                 latest trips, "check now"
   3. call Travelpayouts                      │
   4. save results  ──► price_snapshots ◄─────┘
   5. compare to 14-day median
   6. if drop > threshold ──► alerts
        │
        ▼
      Resend ──► email
```

All tables have row-level security on with no public policies: only the Edge Functions (service role) can read or write data.

## Two price sources

- **Travelpayouts (Aviasales cache):** free and broad, but it only knows dates people searched recently, so trips months ahead often have no data yet. Fares are per adult.
- **Google Flights via SerpApi:** live prices for exact date pairs, priced for the whole group, with Google's low/typical/high verdict. The free plan allows 100 searches a month, so it makes **3 searches a day** (`SERPAPI_DAILY_SEARCHES`), 1 per scheduled check (`SERPAPI_SEARCHES_PER_RUN`): it re-checks the cheapest known date pair, then works through the others, least recently checked first. Every search is recorded in `search_log`, and a Google price counts as current for 12 days.

## How alerts work

- Every day the function stores the cheapest fare for every date combination that matches a watch.
- For each route (e.g. GDN→ATH), it takes **today's best known fare** (view `route_daily_best`) and compares it to the **median of the route's daily best over the last 14 days**.
- If today's fare is at least `drop_pct` below that median, you get an email.
- Alerts use **earlier checks** as history: the median rule needs 3 earlier checks; a **new lowest price** (≥3% under the previous low) alerts after just 1.
- A route that already alerted in the last 7 days only alerts again if the price drops further.
- Prices are per adult. The family total counts adults and children aged 2+ as full seats, which is how low-cost airlines charge.

## Project layout

```
supabase/
  migrations/                 database schema (applied automatically on deploy)
  functions/check-prices/     the daily job
    logic.ts                  pure logic: search plan, filtering, alert rules
    email.ts                  alert email template
    index.ts                  I/O: Travelpayouts, database, Resend
  functions/api/              HTTP API for the dashboard (password-protected)
  functions/weekly-digest/    weekly summary email
  functions/_shared/          API clients (Travelpayouts, SerpApi, Resend), digest, shared queries
  examples/watches.sql        example watches, if you prefer SQL
web/                          the dashboard (no build step)
tests/                        unit tests for logic.ts (npm test)
scripts/serve.mjs             local static server for web/ (npm run dev)
.github/workflows/
  deploy.yml                  test → type-check → migrate DB → sync secrets → deploy functions
  check-prices.yml            manual price check (the schedule itself runs in Supabase pg_cron)
  pages.yml                   publish web/ to GitHub Pages
  weekly-digest.yml           send the weekly summary on demand
```

## Setup

1. **Create accounts** (all free): Supabase, [Travelpayouts](https://www.travelpayouts.com), [Resend](https://resend.com).
2. **Add GitHub secrets** in repo → Settings → Secrets and variables → Actions → *New repository secret*:

   | Secret | Where to get it |
   |---|---|
   | `SUPABASE_ACCESS_TOKEN` | supabase.com → avatar → Account preferences → Access Tokens |
   | `SUPABASE_DB_PASSWORD` | The password set when creating the project (reset in Project Settings → Database) |
   | `TRAVELPAYOUTS_TOKEN` | Travelpayouts → Tools → API → token |
   | `RESEND_API_KEY` | Resend → API Keys |
   | `ALERT_EMAIL_TO` | Your email address (the one you signed up to Resend with) |
   | `CRON_SECRET` | Any long random string |
   | `APP_PASSWORD` | The password you'll type to open the dashboard |
   | `SERPAPI_KEY` | serpapi.com → Dashboard → API key (free plan: 100 searches/month) |

3. **Deploy the backend**: Actions → *Test & deploy* → *Run workflow*.
4. **Turn on the website**: Settings → Pages → Source: **GitHub Actions**, then Actions → *Website* → *Run workflow*.
5. **Open the dashboard**, sign in with `APP_PASSWORD`, add a watch, and click **Check prices now**.

## Local development

```bash
npm test          # unit tests
npm run check     # type-check Edge Functions (downloads Deno via npx)
npm run dev       # serve web/ at http://localhost:5173 (add ?demo for sample data)
```

## Free-tier notes

- **Travelpayouts** returns cached prices from recent user searches, not live fares. Busy routes have good data; smaller routes may be missing some dates.
- **Resend** without a verified domain can only send to your own account email.
- **GitHub** turns off scheduled workflows after 60 days with no repo activity. It emails you first, and one click turns it back on.
- **Supabase** pauses free projects after a period of inactivity. The daily function call should keep it active; if it pauses, restore it from the dashboard.

## Roadmap

1. ~~MVP: tables, check-prices function, email alerts~~
2. ~~Web dashboard with price charts~~
3. ~~Weekly summary email (Sundays ~18:03 Warsaw time)~~
4. Natural-language watch creation (LLM): "Japan in spring for 2+ weeks from Gdansk, Warsaw or Berlin"

# Flight Watcher

Your own flight price tracker: it checks the trips you care about three times a day, charts the price trend, and emails you when a fare drops. Everything runs on free tiers, under your own accounts.

**[Live demo with sample data](https://goreckip.github.io/flight-watcher/?demo)** · **[Set up your own copy → SETUP.md](SETUP.md)** (about 30 minutes, no coding)

## What it does

- **Watches:** you describe a trip, e.g. *"Warsaw → Lisbon over Easter: leave from 27 March, back by 11 April, 6–9 nights, at most 1 stop and 5 hours each way, 2 adults + kids aged 6 and 10"*.
- **Checks prices three times a day** (07:17, 14:05, 20:05 in your time zone) from two sources:
  - **Google Flights** (via SerpApi): live prices for exact dates, priced for your whole group.
  - **Aviasales cache** (via Travelpayouts): free and broad, best for dates in the next few weeks.
- **Email alerts** when the best fare is ≥10% below the recent median, or a new lowest price appears.
- **Weekly summary email** on Sundays: cheapest dates, the week's trend, top date options.
- **Dashboard** (password-protected):
  - a price chart with a point for every check, colored by airline
  - the 10 lowest prices seen
  - "when are prices lowest?" by time of day and weekday
  - a history of every check
  - a diagnose tool for when nothing is found

## How it works

```
Supabase pg_cron (07:17 / 14:05 / 20:05)        Dashboard (GitHub Pages)
        │  POST + shared secret                         │  password
        ▼                                               ▼
Edge Function "check-prices"  ◄──── "Check now" ─── Edge Function "api"
   1. Aviasales cache: whole months of fares            watches, charts, history,
   2. Google Flights: 1 exact date pair per check         diagnose, test email
   3. save fares, observations, chart points
   4. compare with earlier checks ──► alert email (Resend)
                                                  Sunday 18:03 ──► weekly summary email
```

| Part | Tool (free tier) |
|---|---|
| Database, backend, scheduler | Supabase (Postgres, Edge Functions, pg_cron) |
| Dashboard | Static HTML/JS + Chart.js on GitHub Pages |
| Deploys | GitHub Actions |
| Flight prices | SerpApi (Google Flights, 100 searches/month) + Travelpayouts |
| Email | Resend |

All tables have row-level security with no public policies: only the Edge Functions can read or write data. Secrets live in GitHub and Supabase, never in the code, and public workflow logs show only totals.

## Price sources and limits

- **Google Flights via SerpApi:** the free plan allows 100 searches a month, so the app makes **3 a day**, 1 per scheduled check. Each search:
  - re-checks the cheapest known date pair, or
  - checks the date pair searched longest ago.

  A Google price counts as current for 12 days. Optional: without a key, only the Aviasales cache is used.
- **Aviasales cache via Travelpayouts:** only knows dates other people searched recently. Trips months ahead often have no data until closer to the date. Prices are per adult; group totals are estimated (children aged 2+ pay a full seat).

## How alerts work

- History is per check, over the last 14 days.
- **Price drop:** the best fare is at least the watch's `drop_pct` (default 10%) below the median of earlier checks. Needs 3 earlier checks.
- **New lowest price:** at least 3% below the lowest price seen before. Needs 1 earlier check.
- A route alerted in the last 7 days only alerts again if the price beats that alert.

## Project layout

```
supabase/
  migrations/                 database schema + scheduler (applied automatically on deploy)
  functions/check-prices/     the price check: logic.ts (pure rules), email.ts, index.ts
  functions/api/              HTTP API for the dashboard (password-protected)
  functions/weekly-digest/    weekly summary email
  functions/_shared/          SerpApi, Travelpayouts, Resend clients; digest; timing analysis
  examples/watches.sql        example watches, if you prefer SQL
web/                          the dashboard (no build step); config.js is written on deploy
tests/                        unit tests (npm test)
.github/workflows/            deploy, website, manual check, manual weekly summary
```

## Configuration

Set in your repository: Settings → Secrets and variables → Actions. Full walkthrough in [SETUP.md](SETUP.md).

| Variables (not secret) | |
|---|---|
| `SUPABASE_PROJECT_REF` | **Required.** Your Supabase project id |
| `TIMEZONE` | Optional, default `Europe/Warsaw`. Schedule and dashboard times |
| `COUNTRY` | Optional, default `pl`. Google Flights market (two-letter country code) |
| `DASHBOARD_URL` | Optional. Link in emails; defaults to your GitHub Pages address |

| Secrets | |
|---|---|
| `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` | Let GitHub deploy to your Supabase project |
| `TRAVELPAYOUTS_TOKEN` | Aviasales cache prices |
| `SERPAPI_KEY` | Google Flights prices (optional but recommended) |
| `RESEND_API_KEY`, `ALERT_EMAIL_TO` | Alert emails |
| `APP_PASSWORD` | Dashboard password |
| `CRON_SECRET` | Shared secret between the scheduler and the functions |

## Local development

```bash
npm test          # unit tests
npm run check     # type-check Edge Functions (downloads Deno via npx)
npm run dev       # serve web/ at http://localhost:5173 (open /?demo for sample data)
```

## License

[MIT](LICENSE). Use it, change it, share it.

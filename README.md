# Flight Watcher

A personal agent that checks flight prices every day and emails you when a fare drops.

## What it does

- Monitors "watches": origins, destinations, a departure window, a stay length, max stops, max journey time per direction, and who's travelling (for a family price estimate)
- Stores daily price snapshots so you can see price trends
- Emails an alert when a price drops more than your threshold (e.g. 10%) below its recent median

## Stack (free tiers)

| Part | Tool |
|---|---|
| Database | Supabase Postgres |
| Backend logic | Supabase Edge Functions (TypeScript) |
| Daily scheduler | GitHub Actions cron |
| Flight prices | Travelpayouts Data API |
| Email | Resend |

## Architecture

```
GitHub Actions (daily)
        │  POST
        ▼
Supabase Edge Function "check-prices"
   1. load active watches          ◄── watches
   2. build search plan
   3. call Travelpayouts
   4. save results                 ──► price_snapshots
   5. compare to 14-day median
   6. if drop > threshold          ──► alerts
        │
        ▼
      Resend ──► email
```

## Roadmap

1. MVP: tables, check-prices function, email alerts
2. Weekly trend digest email
3. Natural-language watch creation (LLM)
4. Web dashboard with price charts

## How alerts work

- Every day the function stores the cheapest fare for every date combination that matches a watch.
- For each route (e.g. GDN→AGP), it takes **today's cheapest fare** and compares it to the **median of the route's daily cheapest fare over the last 14 days**.
- If today's fare is at least `drop_pct` below that median, you get an email.
- Alerts start after **3 days of history**, because there's no baseline before that.
- A route that already alerted in the last 7 days only alerts again if the price drops further.

## Project layout

```
supabase/
  migrations/                 database schema (applied automatically on deploy)
  functions/check-prices/     the daily job (Deno / TypeScript)
    logic.ts                  pure logic: search plan, filtering, alert rules
    email.ts                  alert email template
    index.ts                  I/O: Travelpayouts, database, Resend
  examples/watches.sql        example watches to paste into the SQL editor
tests/                        unit tests for logic.ts (run: npm test)
.github/workflows/
  deploy.yml                  test → migrate DB → sync secrets → deploy function
  check-prices.yml            daily trigger (05:00 UTC) + manual "Run workflow"
```

## Setup

1. **Create accounts** (all free): Supabase (project already created), [Travelpayouts](https://www.travelpayouts.com), [Resend](https://resend.com).
2. **Add GitHub secrets** in repo → Settings → Secrets and variables → Actions → *New repository secret*:

   | Secret | Where to get it |
   |---|---|
   | `SUPABASE_ACCESS_TOKEN` | supabase.com → avatar → Account preferences → Access Tokens |
   | `SUPABASE_DB_PASSWORD` | The password set when creating the project (reset in Project Settings → Database) |
   | `TRAVELPAYOUTS_TOKEN` | Travelpayouts → Tools → API → token |
   | `RESEND_API_KEY` | Resend → API Keys |
   | `ALERT_EMAIL_TO` | Your email address (the one you signed up to Resend with) |
   | `CRON_SECRET` | Any long random string |

3. **Deploy**: Actions → *Test & deploy* → *Run workflow*. This creates the tables, stores the function secrets, and deploys the function.
4. **Add watches**: open Supabase → SQL Editor and paste in `supabase/examples/watches.sql` with your dates.
5. **Test run**: Actions → *Check prices* → *Run workflow*. The run summary shows what was found.

## Free-tier notes

- **Travelpayouts** returns cached prices from recent user searches, not live fares. Busy routes have good data; smaller routes may be missing some dates.
- **Resend** without a verified domain can only send to your own account email.
- **GitHub** turns off scheduled workflows after 60 days with no repo activity. It emails you first, and one click turns it back on.
- **Supabase** pauses free projects after a period of inactivity. The daily function call should keep it active; if it pauses, restore it from the dashboard.

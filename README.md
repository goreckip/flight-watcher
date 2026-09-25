# Flight Watcher

A personal agent that checks flight prices every day and emails you when a fare drops.

## What it does

- Monitors "watches": origins, destinations, a departure window, a stay length, and direct-only if you want it
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

## Setup

_Coming with step 1._

# Set up your own Flight Watcher

About **30 minutes**, no coding, **free**. You'll create a few free accounts, paste their keys into GitHub, and click "Run". Your copy runs entirely on your own accounts: your trips, prices and keys are never shared with anyone.

Keep a notes file open while you go: you'll collect a few keys and IDs, then paste them into GitHub in step 6.

---

## 1. Make your copy on GitHub

1. Sign in to [GitHub](https://github.com) (create a free account if you need one).
2. Open the original repository and click **Fork** (top right) → **Create fork**.
   - Forking keeps a link to the original, so you can pick up improvements later with one click (see [Updating](#updating)).
   - Your copy will be public; that's required for the free dashboard hosting. It contains only code: your keys go into GitHub's encrypted *secrets*, and your trips and prices live in your own private database.
3. In your fork, open the **Actions** tab and click **"I understand my workflows, go ahead and enable them"**.

## 2. Supabase (database and backend)

1. Sign up at [supabase.com](https://supabase.com) → **New project**.
   - **Name:** anything, e.g. `flight-watcher`
   - **Database password:** click *Generate*, then **copy it to your notes**. You'll need it in step 6.
   - **Region:** the one closest to you
2. When the project is ready, copy its **Project ID**: it's the code in the address bar (`supabase.com/dashboard/project/<this part>`), also shown under Project Settings → General.
3. Create an access token so GitHub can deploy for you: click your avatar (top right) → **Account preferences** → **Access Tokens** → **Generate new token**. Copy it to your notes; it starts with `sbp_`.

## 3. Travelpayouts (Aviasales prices)

1. Sign up at [travelpayouts.com](https://www.travelpayouts.com). If it asks about your website, give your GitHub fork's address and say it's a personal price tracker.
2. Find your **API token** in your account (under Tools → API, or your profile) and copy it.

## 4. SerpApi (Google Flights prices): optional but recommended

1. Sign up at [serpapi.com](https://serpapi.com) on the **free plan** (100 searches/month; the app uses about 93).
2. Copy **Your private API key** from the dashboard.

Without it everything still works, but only with the Aviasales cache, which often has no prices for trips several months ahead.

## 5. Resend (email alerts)

1. Sign up at [resend.com](https://resend.com) **with the email address where you want alerts**. On the free plan, Resend only delivers to that address.
2. **API Keys → Create API key** with *Sending access*. Copy it; it starts with `re_`.

## 6. Paste everything into GitHub

In your fork: **Settings → Secrets and variables → Actions**.

**Variables tab → New repository variable:**

| Name | Value |
|---|---|
| `SUPABASE_PROJECT_REF` | Your Supabase Project ID (step 2.2) |
| `TIMEZONE` | *Optional.* Your time zone, e.g. `Europe/London` ([list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)). Default: `Europe/Warsaw` |
| `COUNTRY` | *Optional.* Two-letter country for Google Flights prices, e.g. `gb`, `de`. Default: `pl` |

**Secrets tab → New repository secret.** Names must match exactly, in capitals:

| Name | Value |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | Token from step 2.3 (`sbp_…`) |
| `SUPABASE_DB_PASSWORD` | Database password from step 2.1 |
| `TRAVELPAYOUTS_TOKEN` | Token from step 3 |
| `SERPAPI_KEY` | Key from step 4 (skip if you didn't sign up) |
| `RESEND_API_KEY` | Key from step 5 (`re_…`) |
| `ALERT_EMAIL_TO` | The email you used for Resend |
| `APP_PASSWORD` | A password you choose for your dashboard. Make it long: 4–5 random words works well |
| `CRON_SECRET` | Any long random text, e.g. from a password generator. You never type it anywhere else |

## 7. Turn on the dashboard website

**Settings → Pages** → under *Build and deployment*, set **Source: GitHub Actions**.

## 8. Deploy

1. **Actions → Test & deploy → Run workflow.** Wait about 2 minutes for the green check.
   This creates your database, uploads your keys to Supabase, deploys the backend and starts the schedule.
2. **Actions → Website → Run workflow.** About 1 minute.

## 9. Use it

1. Open **`https://<your-github-username>.github.io/<your-repo-name>/`** and sign in with your `APP_PASSWORD`.
2. Click **+ New watch** and describe your trip. Airport or city codes are 3 letters, e.g. `WAW`, `LON`, `BCN`.
3. Click **Check prices now**, then **Send test alert** at the bottom to confirm email works.

From then on it checks prices at **07:17, 14:05 and 20:05** and sends a weekly summary on **Sundays at 18:03**, in your time zone.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| *Test & deploy* is red | Open the run: the first step lists exactly which secret or variable is missing. Add it and run again. |
| Website says "This dashboard isn't connected yet" | Set the `SUPABASE_PROJECT_REF` variable, then run **Website** again. |
| "Wrong password" | Use exactly your `APP_PASSWORD`. If you changed it, run **Test & deploy** again so Supabase gets the new one. |
| No email | Check spam. `ALERT_EMAIL_TO` must be the email of your Resend account. |
| A watch finds 0 fares | Click **Diagnose** on the watch: it shows what each source returned and which rule filtered fares out. |
| The dashboard stopped updating after a few quiet weeks | Supabase may have paused the free project: open supabase.com and click **Restore**. |

## Updating

When the original project gets improvements, your fork shows *"This branch is X commits behind"*. Click **Sync fork → Update branch**. That triggers *Test & deploy* and *Website* automatically, and your data and settings stay as they are.

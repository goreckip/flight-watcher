-- The scheduler's local time comes from app_config.timezone (set at deploy from the TIMEZONE
-- repository variable), so copies of this project can run in any time zone.
create or replace function public.call_function_if_due(fn text, local_hours int[], local_dow int default null)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  tz        text := coalesce((select value from public.app_config where key = 'timezone'), 'Europe/Warsaw');
  local_now timestamp := now() at time zone tz;
  base      text;
  secret    text;
begin
  if not (extract(hour from local_now)::int = any (local_hours)) then return; end if;
  if local_dow is not null and extract(dow from local_now)::int <> local_dow then return; end if;

  select value into base   from public.app_config where key = 'functions_url';
  select value into secret from public.app_config where key = 'cron_secret';
  if base is null or secret is null then
    raise warning 'call_function_if_due: app_config not set up yet';
    return;
  end if;

  perform net.http_post(
    url := base || '/' || fn,
    headers := jsonb_build_object('x-cron-secret', secret, 'x-trigger', 'schedule', 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
end;
$$;

revoke execute on function public.call_function_if_due(text, int[], int) from public, anon, authenticated;

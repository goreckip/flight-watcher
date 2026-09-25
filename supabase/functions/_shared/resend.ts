// Send email through Resend. Shared by check-prices (alerts) and api (test email).

export async function sendEmail(subject: string, html: string): Promise<{ id: string | null; to: string[] }> {
  const key = Deno.env.get("RESEND_API_KEY");
  const toRaw = Deno.env.get("ALERT_EMAIL_TO");
  if (!key) throw new Error("Missing env var RESEND_API_KEY");
  if (!toRaw) throw new Error("Missing env var ALERT_EMAIL_TO");
  const to = toRaw.split(",").map((s) => s.trim()).filter(Boolean);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: Deno.env.get("ALERT_EMAIL_FROM") ?? "Flight Watcher <onboarding@resend.dev>",
      to,
      subject,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json().catch(() => ({}));
  return { id: body.id ?? null, to };
}

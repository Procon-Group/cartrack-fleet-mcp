/**
 * Default date-range helper: "previous 24 hours" in Namibia local time (UTC+2, no DST).
 *
 * IMPORTANT — unverified assumption: the Cartrack OpenAPI spec's `date` schema
 * (e.g. "2023-01-01 12:00:00") carries no timezone marker, so it's unclear from the spec
 * alone whether the API expects/returns UTC or each vehicle's terminal-local time. Confirm
 * this against a real response before trusting the dashboard's day boundaries — see the
 * README "Before scheduling" section.
 */

const DEFAULT_OFFSET_MINUTES = Number(process.env.FLEET_TIMEZONE_OFFSET_MINUTES ?? "120");

export function previous24HourWindow(offsetMinutes: number = DEFAULT_OFFSET_MINUTES): { start: string; end: string } {
  const now = new Date();
  const localNow = new Date(now.getTime() + offsetMinutes * 60_000);
  const localStart = new Date(localNow.getTime() - 24 * 60 * 60_000);
  return { start: formatCartrackTs(localStart), end: formatCartrackTs(localNow) };
}

export function formatCartrackTs(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

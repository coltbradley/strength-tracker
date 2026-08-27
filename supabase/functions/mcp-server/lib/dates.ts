// Shared date logic. Two jobs:
//
// 1. Validation. Zod regexes catch shape, not reality: 2026-13-40 passes
//    YYYY-MM-DD and then surfaces as an opaque Postgres error. Validate the
//    calendar here and fail with a clean ToolError naming the parameter.
//
// 2. "Today". This MUST agree with the database, which buckets every calendar
//    date through app_tz() -- the lifter's home timezone, read from the
//    app_config table (migration 20260825130000_app_config.sql). A UTC "today"
//    runs ahead of the lifter's for the last 7-8 hours of every local day west
//    of UTC, which stamped tomorrow's date onto an evening training max, hid
//    it from v_current_tm, and then made %TM programs unresolvable. There is
//    one definition of the calendar day per writer and they must all resolve
//    to the same date: SQL views use app_tz(), this server reads the same
//    app_config row, and the PWA uses the device clock (correct there -- the
//    phone travels with the lifter; see docs/decisions.md).

import type { Db } from "./db.ts";
import { ToolError } from "./errors.ts";

/**
 * Assert a string is a real calendar date in YYYY-MM-DD form and return it.
 * Round-trips through Date (strict ISO parsing) so impossible dates like
 * 2026-02-30 are rejected, not just malformed strings.
 */
export function assertIsoDate(value: string, param: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    ) {
      return value;
    }
  }
  throw new ToolError(
    `Invalid ${param} '${value}': must be a real calendar date in YYYY-MM-DD format.`,
  );
}

/**
 * The calendar date an instant falls on in `tz`, as YYYY-MM-DD. The TypeScript
 * equivalent of Postgres `(instant at time zone tz)::date`.
 *
 * Assembled from formatToParts rather than trusting a locale to emit
 * YYYY-MM-DD. Throws on an unusable IANA zone: a bad app_config.tz would make
 * Postgres error too, so it must not degrade silently to UTC here.
 */
export function isoDateInTz(instant: Date, tz: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
  } catch {
    throw new Error(
      `app_config.tz '${tz}' is not a usable IANA time zone. ` +
        "Fix it with: update app_config set value = '<Area/City>' where key = 'tz';",
    );
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year").padStart(4, "0")}-${get("month")}-${get("day")}`;
}

// Cached for the life of the isolate. The timezone is deployment config
// changed by hand in the dashboard, not per-request data, and edge isolates
// are short-lived -- so a change takes effect on the next cold start rather
// than instantly. Documented in docs/setup.md.
let cachedTz: string | null = null;

/**
 * The lifter's home timezone, from the same app_config row app_tz() reads.
 * Falls back to UTC only when the row is absent, matching the SQL
 * `coalesce(..., 'UTC')`. A read *error* is not a missing row: it throws,
 * because silently guessing a timezone is how the dates drifted in the first
 * place.
 */
export async function appTz(db: Db): Promise<string> {
  if (cachedTz !== null) return cachedTz;
  const { data, error } = await db.client
    .from("app_config")
    .select("value")
    .eq("key", "tz")
    .maybeSingle();
  if (error) throw new Error(`read app_config.tz: ${error.message}`);
  const tz = (data as { value: string } | null)?.value ?? "UTC";
  isoDateInTz(new Date(), tz); // validate before caching
  cachedTz = tz;
  return tz;
}

/** Today's date in the lifter's home timezone, as YYYY-MM-DD. */
export async function todayIso(db: Db): Promise<string> {
  return isoDateInTz(new Date(), await appTz(db));
}

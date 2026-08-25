// Shared date validation. Zod regexes catch shape, not reality: 2026-13-40
// passes YYYY-MM-DD and then surfaces as an opaque Postgres error. Validate
// the calendar here and fail with a clean ToolError naming the parameter.

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

/** Today's date (UTC) as YYYY-MM-DD. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

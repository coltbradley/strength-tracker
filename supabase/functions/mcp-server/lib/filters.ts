// PostgREST filter-string hygiene.
//
// A PostgREST `or=(name.ilike.%x%,id.ilike.%x%)` filter is parsed as a STRING,
// so every character the caller typed lands inside a grammar rather than
// beside it. Commas end a term and parentheses end the group; `%` and its
// alias `*` are the ilike wildcards; a double quote opens a quoted value and a
// backslash escapes inside one.
//
// The comma and paren cases were handled from the start. The quote was not,
// and it is the sharp one: an UNBALANCED `"` leaves PostgREST unable to parse
// the filter at all, so the request 400s, the tool throws something that is
// not a ToolError, and the model is told "Unexpected server error. Reference
// request_id ..." while an error with a stack trace lands in the logs. All of
// that for a lifter searching `5" deficit deadlift`.
//
// This was never a data-exposure hole — the ownership filter is a separate
// AND'd clause and a mangled search term cannot widen it — but a confusing
// failure that pages someone reading logs is still a failure worth removing.
const RESERVED = /[,()%*"\\]/g;

/**
 * A user-typed search term, reduced to something safe to interpolate into a
 * PostgREST filter. Reserved characters become spaces rather than being
 * deleted, so `bench,press` stays two words instead of collapsing into one
 * token that matches nothing.
 */
export function safeFilterTerm(value: string): string {
  return value.replace(RESERVED, " ").trim().replace(/\s+/g, " ");
}

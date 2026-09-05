// The characters a search term is allowed to carry into a PostgREST filter.
//
// The stripping was there from the start for `,()%`; `"` and `\` were missed,
// and an unbalanced quote is not a wrong result but an unparseable filter --
// a 400 that reaches the model as "Unexpected server error" and the logs as a
// stack trace, for a lifter searching `5" deficit`.
//
//   deno test --allow-env --allow-net lib/

import { assertEquals } from "jsr:@std/assert@^1";
import { safeFilterTerm } from "./filters.ts";

Deno.test("the or() delimiters cannot survive a search term", () => {
  // A comma ends a term and a paren ends the group: both would have made the
  // caller's text into filter STRUCTURE.
  assertEquals(safeFilterTerm("bench,press"), "bench press");
  assertEquals(safeFilterTerm("squat)"), "squat");
  assertEquals(safeFilterTerm("row(1)"), "row 1");
});

Deno.test("quotes and backslashes are stripped, not passed through", () => {
  // The regression this file exists for.
  assertEquals(safeFilterTerm('5" deficit deadlift'), "5 deficit deadlift");
  assertEquals(safeFilterTerm('bench "press'), "bench press");
  assertEquals(safeFilterTerm("row\\press"), "row press");
  assertEquals(safeFilterTerm('\\"'), "");
});

Deno.test("both spellings of the ilike wildcard are removed", () => {
  // The term is interpolated between two `%` of ours. A `%` or its alias `*`
  // inside it is a wildcard the caller did not know they were writing.
  assertEquals(safeFilterTerm("100% squat"), "100 squat");
  assertEquals(safeFilterTerm("bench*"), "bench");
});

Deno.test("ordinary searches are returned unchanged", () => {
  assertEquals(safeFilterTerm("bench press"), "bench press");
  assertEquals(safeFilterTerm("  romanian deadlift  "), "romanian deadlift");
  // Hyphens, apostrophes and digits are not reserved and real names use them.
  assertEquals(safeFilterTerm("farmer's walk"), "farmer's walk");
  assertEquals(safeFilterTerm("t-bar row"), "t-bar row");
});

Deno.test("a term of nothing but reserved characters collapses to empty", () => {
  // The caller checks for this and answers with a ToolError. Interpolating it
  // would build `name.ilike.%%`, which matches the whole library and calls it
  // a search result.
  assertEquals(safeFilterTerm("%%%"), "");
  assertEquals(safeFilterTerm("(),"), "");
});

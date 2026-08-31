// Matching an exercise by what someone actually types.
//
// The picker used `name.toLowerCase().includes(query)`, which fails the way
// people search. "rdl" misses "Romanian Deadlift". "bulg split" misses
// "Barbell Bulgarian Split Squat" because of the word between them. "bench
// pres" misses everything over one typo, in a library of 873 names nobody has
// memorised.
//
// Not a generic fuzzy library: initials and out-of-order words are what this
// actually needs, and a full edit-distance matcher over 873 rows on every
// keystroke is both slower and worse — it happily matches "curl" to "Crunch".

/** Words, lowercased, punctuation dropped. "Half-Kneeling" -> [half, kneeling] */
function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** First letter of each word: "Romanian Deadlift" -> "rd" */
function initials(w: string[]): string {
  return w.map((x) => x[0]).join("");
}

/**
 * Score a name against a query. Higher is better; 0 means no match.
 *
 * The tiers matter more than the numbers. An exact prefix must beat a
 * mid-word hit, or typing "press" puts "Leg Press" above "Press" itself.
 */
export function score(name: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (q === "") return 1;

  const lower = name.toLowerCase();
  const nameWords = words(name);
  const qWords = words(query);

  if (lower === q) return 1000;
  if (lower.startsWith(q)) return 900 - lower.length;
  // A word in the middle starting with the query: "press" -> "Bench Press".
  if (nameWords.some((w) => w.startsWith(q))) return 800 - lower.length;
  if (lower.includes(q)) return 700 - lower.length;

  // Everything below matches on WORDS, and words() keeps only [a-z0-9]. A
  // query made entirely of other characters — "深蹲", "🔥", "???" — tokenizes
  // to the empty array, and `[].every(...)` is true, so the one-typo branch at
  // the bottom returned a positive score for every exercise in the library:
  // 873 results, and no "add a new exercise" prompt, because that only appears
  // when a search finds nothing. The literal comparisons above run first and
  // are script-agnostic, so a custom exercise actually named 深蹲 is still
  // found by typing it.
  if (qWords.length === 0) return 0;

  // Initials: "bbs" -> Barbell Bulgarian Squat.
  const init = initials(nameWords);
  if (init === q) return 650;
  if (init.startsWith(q)) return 600 - lower.length;

  // Abbreviations that are not pure word initials. "RDL" is R-D-L of Romanian
  // DeadLift: the L is inside a word, because people abbreviate compounds by
  // their parts, not by spaces. So: the letters in order anywhere in the name,
  // with the first landing on a word start. Held to short queries — over about
  // five letters a subsequence match starts finding nonsense.
  const letters = nameWords.join("");
  if (
    q.length >= 2 &&
    q.length <= 5 &&
    nameWords.some((w) => w.startsWith(q[0]!)) &&
    isSubsequence(letters, q)
  ) {
    return 550 - lower.length;
  }

  // Every typed word must hit some word of the name, in any order and as a
  // prefix — "bulg split" finds "Barbell Bulgarian Split Squat", and typing
  // more words narrows rather than breaks.
  if (
    qWords.length > 1 &&
    qWords.every((qw) => nameWords.some((nw) => nw.startsWith(qw)))
  ) {
    return 500 - lower.length;
  }

  // One typo, on a query long enough that a typo is likelier than a different
  // word. Applied per word so "bech press" still finds "Bench Press".
  if (
    qWords.every((qw) =>
      qw.length < 4
        ? nameWords.some((nw) => nw.startsWith(qw))
        : nameWords.some((nw) => withinOneEdit(nw, qw)),
    )
  ) {
    return 300 - lower.length;
  }

  return 0;
}

/** Do the characters of `q` appear in `hay`, in order, not necessarily adjacent? */
function isSubsequence(hay: string, q: string): boolean {
  let i = 0;
  for (const c of hay) {
    if (c === q[i]) i += 1;
    if (i === q.length) return true;
  }
  return false;
}

/**
 * Is `b` reachable from a prefix of `a` in one edit?
 *
 * Deliberately not full Levenshtein over the whole name: comparing a typed
 * word against a longer name-word ("bech" vs "bench") needs prefix tolerance,
 * and bounding it at one edit keeps "curl" from matching "crunch".
 */
function withinOneEdit(a: string, b: string): boolean {
  if (a.startsWith(b)) return true;
  if (Math.abs(a.length - b.length) > 1 && !a.startsWith(b.slice(0, -1)))
    return false;

  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  // Trailing characters of the QUERY are unmatched; of the name, fine (prefix).
  return edits + (b.length - j) <= 1;
}

/** Rank a list by relevance, dropping non-matches. Stable within a tier. */
export function rank<T>(
  items: T[],
  query: string,
  nameOf: (item: T) => string,
): T[] {
  if (query.trim() === "") return items;
  return items
    .map((item, i) => ({ item, i, s: score(nameOf(item), query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);
}

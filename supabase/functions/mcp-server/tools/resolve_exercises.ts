// Many names, one round trip.
//
// A single "write me a pull day" turn made SIX sequential search_exercises
// calls, one per movement, and spent 37 seconds of a turn budget measured in
// the patience of someone standing at a squat rack with a phone. None of those
// six calls was a search: the model already knew what the exercises were
// called and wanted their ids. This is that lookup batched, so N names cost
// two database queries instead of N calls across the network.
//
// It is a WRAPPER over search_exercises' behaviour, never a second matcher:
// the same ilike substring match and the same ranking, where what the lifter
// has actually TRAINED wins and the most recent of those wins first. Two tools
// that disagreed about which "incline press" is the right one would be worse
// than the latency this fixes. The single addition is one tier further down,
// under rankCandidates: an exact name beats the alphabet, because naming ONE
// match is this tool's whole job and search_exercises never had to.
//
// The pure half is exported so it can be tested without a database. Everything
// that decides WHICH exercise a name means lives in resolveNames; the register
// function only fetches rows and hands them over.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { canSeeExercise, must } from "../lib/db.ts";
import {
  guard,
  jsonResult,
  type RequestContext,
  ToolError,
} from "../lib/errors.ts";
import { safeFilterTerm } from "../lib/filters.ts";

/** The batch bound. A whole training day is five or six movements; 25 is a
 *  week of them, and past that the caller is doing something else. */
export const MAX_NAMES = 25;

/** search_exercises' default `limit`. Candidates for one name are cut here in
 *  the same alphabetical order the database returned them and ranked after,
 *  so this tool truncates where search_exercises truncates and nowhere else. */
const PER_NAME_CANDIDATES = 20;

/** How many runners-up an ambiguous answer carries. Enough for the model to
 *  ask a real question, not so many that it reads as a search result. */
const MAX_ALTERNATIVES = 4;

/** A library row plus the ownership join. `source` and `exercise_owners` are
 *  selected for visibility alone: the service role sees everybody's custom
 *  exercises and something has to take them back out. */
export interface LibraryRow {
  id: string;
  name: string;
  equipment: string | null;
  source: string;
  exercise_owners: { user_id: string }[] | { user_id: string } | null;
}

/** What the lifter's own log says about one movement. */
export interface TrainedFact {
  last_trained: string;
  logged_sets: number;
}

export interface ResolvedMatch {
  exercise_id: string;
  name: string;
  equipment: string | null;
  /** Whether this lifter has ever logged it. Always present, because "no" is
   *  an answer the model needs and an absent field is not one. */
  trained: boolean;
  last_trained?: string;
  logged_sets?: number;
}

export interface ResolvedEntry extends Partial<ResolvedMatch> {
  /** The name as it was asked for, echoed back. The model sent a list and
   *  gets a list; without this it has to trust positional alignment alone. */
  query: string;
  status: "ok" | "ambiguous" | "unmatched";
  /** Why nothing matched. Only on `unmatched`. */
  reason?: string;
  /** The runners-up. Only on `ambiguous`, where the point is to ask. */
  alternatives?: ResolvedMatch[];
}

/**
 * Refuse a batch that is not a batch.
 *
 * The bound is enforced here rather than as a zod `.max()` so the refusal
 * arrives as a ToolError the model can read and act on ("split the list"),
 * not as a schema violation from the protocol layer that reads like the tool
 * is broken.
 */
export function assertResolvableNames(names: string[]): string[] {
  if (names.length === 0) {
    throw new ToolError(
      "resolve_exercises needs at least one name in `names`.",
    );
  }
  if (names.length > MAX_NAMES) {
    throw new ToolError(
      `resolve_exercises takes at most ${MAX_NAMES} names per call and got ` +
        `${names.length}. Split the list and call it twice; that is still ` +
        "two round trips instead of one per name.",
    );
  }
  return names;
}

/** The ilike the database would have run, run in memory instead. Substring,
 *  case-insensitive, against the display name or the slug id. */
function matches(row: LibraryRow, lower: string, slug: string): boolean {
  return (
    row.name.toLowerCase().includes(lower) ||
    row.id.toLowerCase().includes(slug)
  );
}

function isExact(row: LibraryRow, lower: string, slug: string): boolean {
  return row.name.toLowerCase() === lower || row.id.toLowerCase() === slug;
}

/**
 * search_exercises' ordering: trained first, most recently trained first among
 * those. The reason is not preference, it is history: the seeded library
 * carries a dozen near-identical variants of most movements, and resolving a
 * name to an untrained one splits a lifter's history in two and leaves them
 * nothing to compare against.
 *
 * The one addition is BELOW that: where search_exercises falls back to the
 * alphabetical order the database returned, an exact name or slug match goes
 * first. search_exercises hands back a list and lets the reader see the
 * alphabet for what it is; this tool has to name ONE match, and a lifter with
 * no history yet would otherwise have every exercise on their first program
 * decided by which variant sorts earliest. Exactness is a signal. The alphabet
 * is not. The sort is stable, so it still holds behind both.
 */
export function rankCandidates(
  rows: LibraryRow[],
  trained: Map<string, TrainedFact>,
  lower: string,
  slug: string,
): LibraryRow[] {
  return [...rows].sort((a, b) => {
    const at = trained.get(a.id)?.last_trained ?? "";
    const bt = trained.get(b.id)?.last_trained ?? "";
    if (at && bt) return bt.localeCompare(at);
    if (at) return -1;
    if (bt) return 1;
    const ax = isExact(a, lower, slug);
    const bx = isExact(b, lower, slug);
    if (ax !== bx) return ax ? -1 : 1;
    return 0;
  });
}

function describe(
  row: LibraryRow,
  trained: Map<string, TrainedFact>,
): ResolvedMatch {
  const fact = trained.get(row.id);
  return {
    exercise_id: row.id,
    name: row.name,
    equipment: row.equipment,
    trained: fact !== undefined,
    ...(fact
      ? { last_trained: fact.last_trained, logged_sets: fact.logged_sets }
      : {}),
  };
}

function resolveOne(
  query: string,
  rows: LibraryRow[],
  trained: Map<string, TrainedFact>,
): ResolvedEntry {
  // Same sanitising as search_exercises, for the same reason: the term was
  // interpolated into a PostgREST filter to fetch these rows, so matching
  // against the raw string here would use characters the query never saw.
  const term = safeFilterTerm(query);
  if (term === "") {
    return {
      query,
      status: "unmatched",
      reason:
        "No searchable characters: this is punctuation the exercise-name " +
        "filter cannot use. Send a word from the movement's name.",
    };
  }
  const lower = term.toLowerCase();
  const slug = lower.replace(/\s+/g, "_");

  const candidates = rows
    .filter((r) => matches(r, lower, slug))
    .slice(0, PER_NAME_CANDIDATES);
  if (candidates.length === 0) {
    return {
      query,
      status: "unmatched",
      reason:
        `Nothing in the library matches '${query}'. Try a shorter or more ` +
        "common wording, or add_exercise if the movement genuinely is not " +
        "there. Do NOT substitute a different exercise silently.",
    };
  }

  const ranked = rankCandidates(candidates, trained, lower, slug);
  const [top, ...rest] = ranked;

  // What "clearly better" means, and why each clause is a real signal rather
  // than a tie-break. One candidate: nothing to be ambiguous with. A single
  // exact match that IS the top: the caller named the movement, not a family
  // of them. Trained beating untrained: the whole ranking rests on it. What is
  // deliberately NOT here is alphabetical order. Winning by being earlier in
  // the alphabet is how a model picks "Barbell Bench Press - Medium Grip" over
  // the bench press someone actually does and never mentions the choice.
  //
  // Note the case this leaves ambiguous on purpose: an exact match that the
  // TRAINED row outranked. The trained row still leads, because it should, but
  // the coach wrote a name that exists in the library and deserves to be asked
  // about rather than quietly passed over.
  const exact = ranked.filter((r) => isExact(r, lower, slug));
  const isTrained = (r: LibraryRow | undefined) =>
    r !== undefined && trained.has(r.id);
  const clear =
    ranked.length === 1 ||
    (exact.length === 1 && exact[0] === top) ||
    (exact.length === 0 && isTrained(top) && !isTrained(rest[0]));

  return {
    query,
    status: clear ? "ok" : "ambiguous",
    ...describe(top, trained),
    ...(clear
      ? {}
      : {
          alternatives: rest
            .slice(0, MAX_ALTERNATIVES)
            .map((r) => describe(r, trained)),
        }),
  };
}

/**
 * The whole decision, as a function of rows the caller already fetched.
 *
 * EVERY name comes back, in the order it was sent, matched or not. A model
 * that asked for six names and got five results cannot tell which one it lost,
 * and the failure mode of guessing is a program that quietly prescribes the
 * wrong movement.
 *
 * Visibility is applied HERE and not left to the query: this server is the
 * service role, RLS is not in the path, and a batch lookup that leaked another
 * account's custom lift would hand it over by name. `canSeeExercise` is the
 * same rule requireExercise uses, so there is one answer to "whose is this"
 * rather than two that can drift.
 */
export function resolveNames(
  names: string[],
  rows: LibraryRow[],
  trained: Map<string, TrainedFact>,
  ownerId: string,
): ResolvedEntry[] {
  const visible = rows.filter((r) => canSeeExercise(r, ownerId));
  return names.map((name) => resolveOne(name, visible, trained));
}

export function registerResolveExercises(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "resolve_exercises",
    {
      title: "Resolve exercise names",
      description:
        "Turn MANY exercise names into library ids in ONE call. Use this " +
        "instead of calling search_exercises once per name whenever you have " +
        "more than one movement in hand: parsing a coach's screenshot, " +
        "checking a day's exercises before upsert_program or " +
        "update_planned_workout. Six sequential search_exercises calls cost a " +
        "lifter standing at the rack about 37 seconds; this is one round " +
        "trip. Use search_exercises when you are EXPLORING ('what cable rows " +
        "are there'), this when you already know what the movements are " +
        "called.\n\n" +
        "Ranking is search_exercises': what this lifter has actually trained " +
        "wins, most recently trained first, an exact name ahead of the " +
        "alphabet behind that. Every name you " +
        "send comes back, in order. `status` is 'ok' when the match is " +
        "clear, 'unmatched' when nothing in the library fits (never " +
        "substitute a different movement for one of these; say so, or use " +
        "add_exercise), and 'ambiguous' when the top match is no better than " +
        "the runner-up, in which case `alternatives` carries the others and " +
        "you should ASK rather than guess. Picking the wrong variant splits " +
        "their history and gives them nothing to compare against.\n\n" +
        "It does not return the lifter's notes on a movement. When you are " +
        "about to PROGRAM one, search_exercises carries the standing cue and " +
        "what they wrote while lifting it, and those change what you should " +
        "prescribe.",
      inputSchema: {
        names: z
          .array(z.string())
          .describe(
            "Exercise names as the coach or lifter wrote them, e.g. " +
              `['incline dumbbell press', 'lat pulldown', 'face pull']. Up to ${MAX_NAMES}.`,
          ),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guard(ctx, "resolve_exercises", async () => {
        const names = assertResolvableNames(args.names);

        // One filter for the whole batch. Each name contributes the same two
        // terms search_exercises builds for a single query, deduped because a
        // one-word name makes the name term and the slug term identical.
        const terms = new Set<string>();
        for (const name of names) {
          const q = safeFilterTerm(name);
          if (q === "") continue;
          terms.add(`name.ilike.%${q}%`);
          terms.add(`id.ilike.%${q.replace(/\s+/g, "_")}%`);
        }

        // Every name was punctuation. Nothing to ask the database.
        const rows =
          terms.size === 0
            ? []
            : (must(
                await db.client
                  .from("exercises")
                  .select(
                    "id, name, equipment, source, exercise_owners(user_id)",
                  )
                  .or([...terms].join(","))
                  .order("name")
                  // Above the size of the whole library on purpose. Truncation
                  // here is not a shorter answer, it is a real exercise
                  // reported as 'unmatched' because an earlier name in the
                  // batch filled the page alphabetically.
                  .limit(2000),
                "resolve exercises",
              ) as unknown as LibraryRow[]);

        // The ranking signal, from the same view search_exercises reads (voids
        // and discarded sessions already excluded). Fetched for the LIFTER
        // rather than for the candidate ids: a 25-name batch produces hundreds
        // of slug ids, and an `in.(...)` list that long builds a URL long
        // enough to be refused outright, which would silently demote every
        // movement they train to untrained.
        const trainedRows =
          rows.length === 0
            ? []
            : (must(
                await db.client
                  .from("v_live_sets")
                  .select("exercise_id, performed_at")
                  .eq("user_id", db.ownerId)
                  .order("performed_at", { ascending: false })
                  .limit(1500),
                "trained exercises",
              ) as unknown as {
                exercise_id: string;
                performed_at: string;
              }[]);

        // Rows arrive newest first, so the first sighting of an exercise is
        // its last_trained and every later one is another set on the count.
        const trained = new Map<string, TrainedFact>();
        for (const t of trainedRows) {
          const seen = trained.get(t.exercise_id);
          if (seen) {
            seen.logged_sets += 1;
            continue;
          }
          trained.set(t.exercise_id, {
            last_trained: t.performed_at,
            logged_sets: 1,
          });
        }

        const resolved = resolveNames(names, rows, trained, db.ownerId);
        const withStatus = (s: ResolvedEntry["status"]) =>
          resolved.filter((r) => r.status === s).map((r) => r.query);

        return jsonResult({
          data: { resolved },
          metadata: {
            count: resolved.length,
            unmatched: withStatus("unmatched"),
            ambiguous: withStatus("ambiguous"),
            guidance:
              "One entry per name you sent, in the order you sent them. " +
              "`trained` is whether this lifter has logged the movement. " +
              "Prefer a trained match, and never put two variants of the same " +
              "movement in one session unless the coach asked for both. " +
              "Resolve the `ambiguous` and `unmatched` names with the user " +
              "before writing a program; a plan built on a guess is one they " +
              "will not train. `logged_sets` counts within their recent " +
              "history, not all time.",
          },
        });
      }),
  );
}

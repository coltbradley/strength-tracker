// One exercise picker. Three hand-rolled copies had drifted apart (Session's
// had the offline message and the equipment accent, Plan's had neither and a
// spinner that never resolved, History's had a different title and a LOGGED
// badge). This is the union of the three, not the intersection:
//
// - the head always states the library size once it is known
// - the equipment tag is always accented for barbell/machine (it is the tag
//   that predicts whether the plate calculator will be useful)
// - an optional per-row badge (History's LOGGED) rides alongside it
// - three distinct bottom states: loading, unavailable-offline, no match
// - search-field attributes that stop iOS autocorrecting "rdl" into "ideal"
//
// Fetching stays at the call site — Session retries on open, Plan lazy-loads,
// History reuses its index — because each screen already owns that cache.

import { useState } from "react";
import { Sheet } from "./Sheet";
import { rank } from "../lib/fuzzy";
import type { ExerciseRow } from "../lib/types";

export interface ExercisePickerProps {
  /** Head label; the library count is appended once the list has loaded. */
  title: string;
  exercises: ExerciseRow[];
  /** The library could not be loaded (offline with a cold cache). */
  failed?: boolean;
  /** Optional short badge for a row, e.g. "LOGGED". */
  badge?: (ex: ExerciseRow) => string | null;
  /** Offered when a search finds nothing, or nothing right: the library will
   *  never have everything, and a movement it lacks is untrackable. Omit to
   *  leave the picker read-only (History has nothing to add an exercise TO). */
  onAddNew?: (query: string) => void;
  /** With an empty query, list badged exercises first (History leads with
   *  the lifts it actually has data for). */
  preferBadged?: boolean;
  onPick: (ex: ExerciseRow) => void;
  onClose: () => void;
}

const LIMIT = 30;

export function ExercisePicker({
  title,
  exercises,
  failed,
  badge,
  preferBadged,
  onPick,
  onAddNew,
  onClose,
}: ExercisePickerProps) {
  const [search, setSearch] = useState("");

  const q = search.trim().toLowerCase();
  // Ranked, not filtered by substring. `includes` misses the way people
  // actually type: "rdl" for Romanian Deadlift, "bulg split" for Barbell
  // Bulgarian Split Squat, one typo in "bech press". See lib/fuzzy.ts.
  const matches = rank(exercises, search, (e) => e.name);
  const ordered =
    q === "" && preferBadged && badge
      ? [
          ...matches.filter((e) => badge(e)),
          ...matches.filter((e) => !badge(e)),
        ]
      : matches;
  const shown = ordered.slice(0, LIMIT);

  return (
    <Sheet
      title={
        exercises.length > 0
          ? `${title} · ${exercises.length} IN LIBRARY`
          : title
      }
      onClose={onClose}
      tall
    >
      <input
        className="input"
        type="search"
        inputMode="search"
        enterKeyHint="search"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        aria-label="search exercises"
        placeholder="Search exercises…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        data-sheet-autofocus
      />
      <div className="search-results">
        {shown.map((ex) => {
          const mark = badge?.(ex) ?? null;
          return (
            <button
              key={ex.id}
              type="button"
              className="drawer-row"
              onClick={() => onPick(ex)}
            >
              <span className="drawer-name">{ex.name}</span>
              {mark && <span className="drawer-tag">{mark}</span>}
              <span
                className={`drawer-tag ${
                  ex.equipment === "barbell" || ex.equipment === "machine"
                    ? "drawer-tag-accent"
                    : ""
                }`}
              >
                {ex.equipment ? ex.equipment.toUpperCase() : ""}
              </span>
            </button>
          );
        })}
        {onAddNew && q !== "" && (
          <button
            type="button"
            className="btn btn-ghost btn-block add-new-row"
            onClick={() => onAddNew(search.trim())}
          >
            {shown.length === 0
              ? `Add “${search.trim()}” as a new exercise`
              : `Not here? Add “${search.trim()}”`}
          </button>
        )}
        {exercises.length === 0 && (
          <p className="muted">
            {failed
              ? "Exercise list unavailable offline — it caches after the first online load."
              : "Loading exercise list…"}
          </p>
        )}
        {exercises.length > 0 && shown.length === 0 && (
          <p className="muted">No exercise matches “{search.trim()}”.</p>
        )}
      </div>
    </Sheet>
  );
}

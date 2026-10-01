// List: the whole workout as a ledger. One card is open (the exercise you are
// on): its logged sets with their receipts, then the dock to log the next.
// Everything else is one quiet row — done ones collapsed, the rest dim — and a
// tap on any row makes it the open card. Corrections and skips stay one tap
// away, inside the open card.
//
// It is a presentation of the same entries, states and logged rows the Focus
// deck and Today's workout read: it owns no draft and no write.

import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { targetSets, type ExerciseEntry, type SupersetTag } from "../../lib/entries";
import { StateGlyph, type ProgressState } from "./StateGlyph";

export interface WorkoutOverviewProps {
  entries: readonly ExerciseEntry[];
  /** the open card's entry */
  currentKey: string | null;
  entryState(entry: ExerciseEntry): ProgressState;
  entryProgress(entry: ExerciseEntry): number;
  isSkipped(entry: ExerciseEntry): boolean;
  hasSections?: boolean;
  supersetInfo?: ReadonlyMap<string, SupersetTag>;
  formatScheme(entry: ExerciseEntry): string;
  /** a row was tapped: make it the open card */
  onJump(entry: ExerciseEntry): void;
  /** the rest strip, above the rows while resting */
  restSlot?: ReactNode;
  /** the open card's body: logged rows and the dock */
  renderCurrent(entry: ExerciseEntry): ReactNode;
}

export function WorkoutOverview({
  entries,
  currentKey,
  entryState,
  entryProgress,
  isSkipped,
  hasSections = false,
  supersetInfo = new Map(),
  formatScheme,
  onJump,
  restSlot,
  renderCurrent,
}: WorkoutOverviewProps) {
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map());

  // A jump brings its card into view: the list can be longer than the screen.
  useEffect(() => {
    if (currentKey === null) return;
    const item = itemRefs.current.get(currentKey);
    if (!item || typeof item.scrollIntoView !== "function") return;
    item.scrollIntoView({
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "nearest",
    });
  }, [currentKey]);

  const sectionOf = (candidate: ExerciseEntry | undefined) =>
    candidate?.brackets[0]?.section ?? null;

  return (
    <div className="wk-overview wk-overview-list">
      {restSlot}
      {entries.map((entry, entryIndex) => {
        const section = sectionOf(entry);
        const previousSection = sectionOf(entries[entryIndex - 1]);
        const showSection = section !== null && section !== previousSection;
        const showMain =
          section === null &&
          hasSections &&
          (entryIndex === 0 || previousSection !== null);
        const state = entryState(entry);
        const current = entry.key === currentKey;
        const skipped = isSkipped(entry);
        const done = entryProgress(entry);
        const total = entry.brackets.length > 0 ? targetSets(entry) : null;
        const superset = supersetInfo.get(entry.key);
        const label = `${entry.name} — ${state}`;

        return (
          <Fragment key={entry.key}>
            {showSection && (
              <div className="wk-section-head">{section.toUpperCase()}</div>
            )}
            {showMain && <div className="wk-section-head">MAIN WORK</div>}
            <article
              ref={(element) => {
                if (element) itemRefs.current.set(entry.key, element);
                else itemRefs.current.delete(entry.key);
              }}
              className={`wk-list-item${current ? " wk-list-item-current" : ""}${state === "done" || skipped ? " wk-list-item-completed" : ""}${state === "upcoming" || state === "next" ? " wk-list-item-ahead" : ""}`}
              data-state={state}
            >
              {current ? (
                <>
                  <div className="wk-list-card-head">
                    {superset && (
                      <span className="wk-superset-tag" aria-label={`Superset ${superset.tag}`}>
                        {superset.tag}
                      </span>
                    )}
                    <h2 className="wk-list-card-name">{entry.name}</h2>
                    <span className="wk-list-count">
                      {done}
                      {total !== null ? `/${total}` : ""}
                    </span>
                  </div>
                  {entry.substitutedFor && (
                    <div className="wk-list-instead">
                      INSTEAD OF {entry.substitutedFor.name.toUpperCase()}
                    </div>
                  )}
                  <div className="wk-list-body">{renderCurrent(entry)}</div>
                </>
              ) : (
                <button
                  type="button"
                  className="wk-list-row"
                  aria-label={label}
                  onClick={() => onJump(entry)}
                >
                  <StateGlyph state={state} label={label} />
                  {superset && (
                    <span className="wk-superset-tag" aria-hidden="true">
                      {superset.tag}
                    </span>
                  )}
                  <span className={`wk-list-name${skipped ? " wk-list-name-skipped" : ""}`}>
                    {entry.name}
                    <span className="wk-list-summary">
                      {skipped
                        ? "SKIPPED"
                        : state === "done"
                          ? `${done} done`
                          : entry.substitutedFor
                            ? `INSTEAD OF ${entry.substitutedFor.name.toUpperCase()}`
                            : formatScheme(entry).toUpperCase() || "BY FEEL"}
                    </span>
                  </span>
                  <span className="wk-list-count">
                    {done}
                    {total !== null ? `/${total}` : ""}
                  </span>
                </button>
              )}
            </article>
          </Fragment>
        );
      })}
    </div>
  );
}

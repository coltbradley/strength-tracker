import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { targetSets, type ExerciseEntry, type SupersetTag } from "../../lib/entries";
import { entryUnits } from "../../lib/entryOrder";
import { ReorderList, type ReorderItem } from "./ReorderList";
import { StateGlyph, type ProgressState } from "./StateGlyph";

export interface WorkoutOverviewProps {
  entries: readonly ExerciseEntry[];
  selectedEntryKey: string | null;
  expandedEntryKey: string | null;
  onSelectEntry(key: string): void;
  onToggleEntry(key: string): void;
  onEnterFocus(): void;
  focusModeAvailable?: boolean;
  renderEditor(entry: ExerciseEntry): ReactNode;
  entryProgress?(entry: ExerciseEntry): number;
  isSkipped?(entry: ExerciseEntry): boolean;
  hasSections?: boolean;
  supersetInfo?: ReadonlyMap<string, SupersetTag>;
  formatScheme?(entry: ExerciseEntry): string;
  renderRowAction?(entry: ExerciseEntry): ReactNode;
  onOpenDemo?(entry: ExerciseEntry): void;
  /** Same shared vocabulary the focus rail uses (StateGlyph.tsx /
   *  lib/sessionFocus.ts's `railState`). Optional so a caller that has no
   *  notion of "current" (there is no live focus session, e.g. read-only
   *  contexts) can omit it; no glyph renders and the row is exactly as it
   *  was before this task. */
  entryState?(entry: ExerciseEntry): ProgressState;
  /** Move one UNIT (a lone exercise or a whole superset) from one place in
   *  today's order to another. Indices are into `entryUnits(entries)`.
   *  Session-local presentation order only — never the plan. Omit to hide the
   *  Reorder control. */
  onMoveUnit?(fromUnit: number, toUnit: number): void;
}

/**
 * The normal session view. Selecting an exercise chooses a future focus
 * destination; expanding its details is deliberately a separate action.
 */
export function WorkoutOverview({
  entries,
  selectedEntryKey,
  expandedEntryKey,
  onSelectEntry,
  onToggleEntry,
  onEnterFocus,
  focusModeAvailable = true,
  renderEditor,
  entryProgress = () => 0,
  isSkipped = () => false,
  hasSections = false,
  supersetInfo = new Map(),
  formatScheme = () => "",
  renderRowAction,
  onOpenDemo,
  entryState,
  onMoveUnit,
}: WorkoutOverviewProps) {
  const [reordering, setReordering] = useState(false);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (expandedEntryKey === null) return;
    const item = itemRefs.current.get(expandedEntryKey);
    if (!item || typeof item.scrollIntoView !== "function") return;
    item.scrollIntoView({
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "start",
    });
  }, [expandedEntryKey]);

  return (
    <div className="wk-overview">
      {focusModeAvailable && (
        <button
          type="button"
          className="btn btn-outline-ink btn-block wk-focus-mode"
          onClick={onEnterFocus}
        >
          Go to current exercise
        </button>
      )}

      {onMoveUnit && entries.length > 1 && (
        <button
          type="button"
          className="btn btn-outline-ink btn-block wk-reorder-toggle"
          aria-pressed={reordering}
          onClick={() => setReordering((on) => !on)}
        >
          {reordering ? "Done reordering" : "Reorder today’s workout"}
        </button>
      )}

      {reordering && onMoveUnit ? (
        <>
          <p className="microcopy">
            Drag ⠿ or use the arrow keys to change today’s order. The plan stays
            the same.
          </p>
          <ReorderList
            items={reorderItems(
              entries,
              supersetInfo,
              hasSections,
              formatScheme,
              entryProgress,
              entryState,
            )}
            selectedKey={selectedEntryKey}
            onMove={onMoveUnit}
            onSelect={(key) => {
              onSelectEntry(key);
              setReordering(false);
            }}
          />
        </>
      ) : (
      entries.map((entry, entryIndex) => {
        const sectionOf = (candidate: ExerciseEntry | undefined) =>
          candidate?.brackets[0]?.section ?? null;
        const section = sectionOf(entry);
        const previousSection = sectionOf(entries[entryIndex - 1]);
        const showSection = section !== null && section !== previousSection;
        const showMain =
          section === null &&
          hasSections &&
          (entryIndex === 0 || previousSection !== null);
        const isExpanded = entry.key === expandedEntryKey;
        const isSelected = entry.key === selectedEntryKey;
        const prescribed = entry.brackets.length > 0;
        const done = entryProgress(entry);
        const total = prescribed ? targetSets(entry) : null;
        const skipped = isSkipped(entry);
        const superset = supersetInfo.get(entry.key);
        const selectedName = isSelected ? `${entry.name}, selected` : entry.name;

        return (
          <Fragment key={entry.key}>
            {showSection && (
              <div className="section-head wk-section-head">
                <span className="field-label">{section.toUpperCase()}</span>
              </div>
            )}
            {showMain && (
              <div className="section-head wk-section-head wk-main-head">
                <span className="field-label">MAIN WORK</span>
              </div>
            )}
            <div
              ref={(element) => {
                if (element) itemRefs.current.set(entry.key, element);
                else itemRefs.current.delete(entry.key);
              }}
              className={`wk-item ${isExpanded ? "wk-item-on" : ""} ${isSelected ? "wk-item-selected" : ""}`}
            >
              <div className="wk-row">
                {superset && (
                  <span
                    className={`wk-superset-rail ${superset.first ? "wk-superset-rail-start" : ""} ${superset.last ? "wk-superset-rail-end" : ""}`}
                  >
                    <span className="wk-superset-tag">{superset.tag}</span>
                  </span>
                )}
                <button
                  type="button"
                  className="wk-main"
                  // Selecting a future focus destination only means something
                  // when Focus mode is on offer. Without it, tapping the name
                  // used to just highlight a row with no visible next step —
                  // main's behaviour (the whole row toggles open/closed) is
                  // restored here so the tap keeps doing something.
                  aria-label={
                    entryState
                      ? `${focusModeAvailable ? selectedName : entry.name} — ${entryState(entry)}`
                      : focusModeAvailable
                        ? selectedName
                        : entry.name
                  }
                  aria-pressed={focusModeAvailable ? isSelected : undefined}
                  onClick={() =>
                    focusModeAvailable
                      ? onSelectEntry(entry.key)
                      : onToggleEntry(entry.key)
                  }
                >
                  {entryState && (
                    <StateGlyph
                      state={entryState(entry)}
                      label={`${entry.name} — ${entryState(entry)}`}
                    />
                  )}
                  <span
                    className={`wk-name ${skipped ? "wk-name-skipped" : ""}`}
                  >
                    {entry.name}
                  </span>
                  <span className="wk-target">
                    {entry.substitutedFor && !skipped
                      ? `INSTEAD OF ${entry.substitutedFor.name.toUpperCase()} · `
                      : ""}
                    {skipped
                      ? "SKIPPED"
                      : prescribed
                        ? formatScheme(entry).toUpperCase()
                        : "NO TARGET · BY FEEL"}
                  </span>
                  <span
                    className={`wk-count ${total !== null && done >= total ? "wk-count-done" : ""}`}
                  >
                    {done}
                    {total !== null ? `/${total}` : ""}
                  </span>
                </button>
                <button
                  type="button"
                  className="wk-expand"
                  aria-expanded={isExpanded}
                  aria-label={isExpanded ? "collapse details" : "expand details"}
                  onClick={() => onToggleEntry(entry.key)}
                >
                  <span aria-hidden="true">{isExpanded ? "▾" : "▸"}</span>
                </button>
                {isExpanded && onOpenDemo && (
                  <button
                    type="button"
                    className="wk-demo"
                    aria-label={`how to do ${entry.name}`}
                    onClick={() => onOpenDemo(entry)}
                  >
                    HOW TO
                  </button>
                )}
                {!isExpanded && renderRowAction?.(entry)}
              </div>
              {isExpanded && <div className="wk-open">{renderEditor(entry)}</div>}
            </div>
          </Fragment>
        );
      })
      )}
    </div>
  );
}

/** One reorder row per unit, headed by the same run-level section label the
 *  overview prints (a section may honestly appear twice after a move). */
function reorderItems(
  entries: readonly ExerciseEntry[],
  supersetInfo: ReadonlyMap<string, SupersetTag>,
  hasSections: boolean,
  formatScheme: (entry: ExerciseEntry) => string,
  entryProgress: (entry: ExerciseEntry) => number,
  entryState?: (entry: ExerciseEntry) => ProgressState,
): ReorderItem[] {
  const sectionOf = (e: ExerciseEntry | undefined) =>
    e?.brackets[0]?.section ?? null;
  let previous: string | null | undefined;
  return entryUnits(entries).map((unit) => {
    const first = unit[0];
    const section = sectionOf(first);
    const heading =
      previous !== section
        ? (section ?? (hasSections ? "Main work" : undefined))
        : undefined;
    previous = section;
    const done = unit.reduce((n, e) => n + entryProgress(e), 0);
    const total = unit.reduce(
      (n, e) => n + (e.brackets.length > 0 ? targetSets(e) : 0),
      0,
    );
    const states = entryState ? unit.map(entryState) : [];
    const state =
      states.find((s) => s === "current") ??
      (states.length > 0 && states.every((s) => s === "done")
        ? "done"
        : states.length > 0 && states.every((s) => s === "skipped")
          ? "skipped"
          : states.find((s) => s === "next")) ??
      states[0];
    return {
      key: first.key,
      title: unit
        .map((e) => {
          const tag = supersetInfo.get(e.key)?.tag;
          return tag ? `${tag} ${e.name}` : e.name;
        })
        .join(" · "),
      subtitle: unit
        .map((e) =>
          e.brackets.length > 0 ? formatScheme(e).toUpperCase() : "BY FEEL",
        )
        .join(" · "),
      meta: total > 0 ? `${done}/${total}` : `${done}`,
      state,
      heading,
    };
  });
}

import { Fragment, type ReactNode, useEffect, useRef } from "react";
import { targetSets, type ExerciseEntry, type SupersetTag } from "../../lib/entries";

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
}: WorkoutOverviewProps) {
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
    <>
      {focusModeAvailable && (
        <button
          type="button"
          className="btn btn-outline-ink btn-block wk-focus-mode"
          onClick={onEnterFocus}
        >
          Focus mode
        </button>
      )}

      {entries.map((entry, entryIndex) => {
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
                  aria-label={selectedName}
                  aria-pressed={isSelected}
                  onClick={() => onSelectEntry(entry.key)}
                >
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
      })}
    </>
  );
}

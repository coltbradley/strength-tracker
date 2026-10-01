// The Note key's sheet: a text box with the cursor already in it, a few quick
// phrases, Save. It annotates ONE set, named in the title, and that set is
// always a live row — the caller resolves it from the live sets, so a note is
// never attached to a voided one (M2). Notes are the one editable thing next
// to a set (set_notes is last-write-wins), so Save replaces what was there.

import { useState } from "react";
import { Sheet } from "../Sheet";

const NOTE_CHIPS = ["Felt fast", "Grindy last rep", "Belt on", "Left knee"];

export function NoteSheet({
  title,
  initial,
  onSave,
  onClose,
}: {
  /** "Note on set 3" */
  title: string;
  initial: string;
  onSave(note: string): void;
  onClose(): void;
}) {
  const [draft, setDraft] = useState(initial);
  const add = (chip: string) =>
    setDraft((d) => (d.trim() === "" ? chip : `${d.trim()}. ${chip}`));
  return (
    <Sheet title={title} onClose={onClose} className="note-sheet">
      <textarea
        className="input note-input note-sheet-input"
        rows={3}
        data-sheet-autofocus
        enterKeyHint="done"
        aria-label={title}
        placeholder="Anything worth remembering about this set…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="chip-row" role="group" aria-label="Quick notes">
        {NOTE_CHIPS.map((chip) => (
          <button key={chip} type="button" className="chip" onClick={() => add(chip)}>
            {chip}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="btn btn-primary btn-block"
        onClick={() => onSave(draft.trim())}
      >
        Save note
      </button>
    </Sheet>
  );
}

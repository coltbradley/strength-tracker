// Collapsible note block. Notes are reference material, not the task at
// hand: long ones clamp to two lines with a MORE toggle so they never
// dominate the screen's hierarchy. Short notes render plainly.

import { useState } from "react";

interface NoteProps {
  label: string;
  text: string;
}

// past this length a note is "long" and starts clamped
const CLAMP_THRESHOLD = 120;

export function Note({ label, text }: NoteProps) {
  const long = text.length > CLAMP_THRESHOLD;
  const [open, setOpen] = useState(false);

  if (!long) {
    return (
      <div className="detail-note">
        <span className="detail-note-label">{label}</span>
        {text}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="detail-note detail-note-toggle"
      aria-expanded={open}
      onClick={() => setOpen(!open)}
    >
      <span className="detail-note-label">
        {label}{" "}
        <span className="detail-note-more">{open ? "LESS ▴" : "MORE ▾"}</span>
      </span>
      <span className={open ? "" : "detail-note-clamped"}>{text}</span>
    </button>
  );
}

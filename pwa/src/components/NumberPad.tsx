// In-app numeric pad — a bottom sheet, deliberately NOT <input type=number>
// and NOT the OS keyboard (viewport shifts, locale decimal keys — see
// handoff-notes conflict 01). Steppers stay available underneath.

import { useState } from "react";
import { Sheet } from "./Sheet";

export interface PadRequest {
  /** header label, e.g. "OVERHEAD PRESS · LOAD IN LB" */
  label: string;
  /** commit button label: SET LOAD / SET REPS / SET WEIGHT / SET REST / BACK TO PLATES */
  action: string;
  /** shown until the first keypress */
  initial: string;
  allowDecimal: boolean;
  /** called with the parsed value; caller clamps to its own limits */
  onCommit: (value: number) => void;
  onCancel: () => void;
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "DEL"];

export function NumberPad({ req }: { req: PadRequest }) {
  const [typed, setTyped] = useState("");

  const press = (k: string) => {
    if (k === "DEL") {
      setTyped((t) => t.slice(0, -1));
      return;
    }
    if (k === "." && (!req.allowDecimal || typed.includes("."))) return;
    setTyped((t) => (t.length >= 6 ? t : t + k));
  };

  const commit = () => {
    const v = parseFloat(typed);
    if (typed === "" || Number.isNaN(v)) {
      req.onCancel();
      return;
    }
    req.onCommit(v);
  };

  return (
    <Sheet
      title={req.label}
      onClose={req.onCancel}
      className="pad-sheet"
      /* CANCEL in the action row IS this sheet's dismissal, so the head
         carries the live value instead of a second exit. */
      headRight={
        <span className="pad-value">{typed === "" ? req.initial : typed}</span>
      }
    >
      <div className="pad-grid">
        {KEYS.map((k) => (
          <button
            key={k}
            type="button"
            className={`pad-key ${k === "." && !req.allowDecimal ? "pad-key-off" : ""}`}
            onClick={() => press(k)}
          >
            {k === "DEL" ? "⌫" : k}
          </button>
        ))}
      </div>
      <div className="pad-actions">
        <button type="button" className="pad-cancel" onClick={req.onCancel}>
          CANCEL
        </button>
        <button type="button" className="pad-done" onClick={commit}>
          {req.action}
        </button>
      </div>
    </Sheet>
  );
}

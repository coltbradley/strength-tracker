// Settings sheet: unit toggle, default rest, plates on hand (per-unit
// catalog, pairs), manual sync, sign out.

import {
  BAR_CATALOG,
  PLATE_CATALOG,
  cycleDefaultRest,
  getBarKg,
  setBarKg,
  setUnit,
  togglePlate,
} from "../lib/settings";
import { formatClock } from "../lib/format";
import { useUnit } from "../hooks/useUnit";
import {
  useBarKg,
  useDefaultRestSeconds,
  usePlatesOnHand,
} from "../hooks/useSettings";
import { toDisplay, type Unit } from "../lib/units";
import { outbox } from "../lib/sync";
import { supabase } from "../lib/supabase";
import { reportError, toast } from "../lib/errors";

interface SettingsSheetProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsSheet({ open, onClose }: SettingsSheetProps) {
  const unit = useUnit();
  const enabled = usePlatesOnHand(unit);
  const barKg = useBarKg(unit);
  const restDefault = useDefaultRestSeconds();
  if (!open) return null;

  const isOn = (p: number) => enabled.some((e) => Math.abs(e - p) < 1e-6);
  const smallest = enabled.length > 0 ? Math.min(...enabled) : null;
  const invNote =
    smallest === null
      ? "No plates enabled — the calculator will only offer the bar."
      : `Smallest jump ${toDisplay(smallest * 2, unit)} ${unit} — plates load in pairs.`;

  const switchUnit = (u: Unit) => {
    setUnit(u);
    // keep the bar selection valid for the unit's catalog
    if (!BAR_CATALOG[u].some((b) => Math.abs(b - getBarKg(u)) < 1e-6)) {
      setBarKg(u, BAR_CATALOG[u][0]);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span className="sheet-title">SETTINGS</span>
          <button type="button" className="sheet-close" onClick={onClose}>
            CLOSE
          </button>
        </div>

        <div className="sheet-row">
          <span>Display unit</span>
          <div className="seg">
            {(["kg", "lb"] as const).map((u) => (
              <button
                key={u}
                type="button"
                className={`seg-btn ${unit === u ? "seg-on" : ""}`}
                onClick={() => switchUnit(u)}
              >
                {u}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          className="sheet-row sheet-row-btn"
          onClick={cycleDefaultRest}
        >
          <span>Default rest</span>
          <span className="sheet-row-value">{formatClock(restDefault)}</span>
        </button>

        <div className="sheet-row sheet-row-stack">
          <span>
            Plates on hand <span className="muted-mono">· pairs</span>
          </span>
          <div className="chip-row">
            {PLATE_CATALOG[unit].map((p) => (
              <button
                key={p}
                type="button"
                className={`chip ${isOn(p) ? "chip-on" : ""}`}
                onClick={() => togglePlate(unit, p)}
              >
                {toDisplay(p, unit)}
              </button>
            ))}
          </div>
          <div className="microcopy">{invNote}</div>
          <div className="chip-row">
            {BAR_CATALOG[unit].map((b) => (
              <button
                key={b}
                type="button"
                className={`chip ${Math.abs(b - barKg) < 1e-6 ? "chip-on" : ""}`}
                onClick={() => setBarKg(unit, b)}
              >
                BAR {toDisplay(b, unit)}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            void outbox.flush();
            toast("sync triggered");
          }}
        >
          Sync now
        </button>

        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            supabase.auth
              .signOut()
              .then(() => onClose())
              .catch((e: unknown) => reportError(e, "sign out"));
          }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

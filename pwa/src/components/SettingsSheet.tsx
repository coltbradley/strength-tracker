// Small settings surface: unit toggle, manual sync, sign out.

import { useUnit } from "../hooks/useUnit";
import { setUnit } from "../lib/settings";
import { outbox } from "../lib/sync";
import { supabase } from "../lib/supabase";
import { reportError, toast } from "../lib/errors";

interface SettingsSheetProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsSheet({ open, onClose }: SettingsSheetProps) {
  const unit = useUnit();
  if (!open) return null;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">Settings</div>

        <div className="sheet-row">
          <span>Units</span>
          <div className="seg">
            {(["kg", "lb"] as const).map((u) => (
              <button
                key={u}
                type="button"
                className={`seg-btn ${unit === u ? "seg-on" : ""}`}
                onClick={() => setUnit(u)}
              >
                {u}
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

        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

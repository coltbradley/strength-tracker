// Settings sheet: unit toggle, default rest, rest alerts, plates on hand
// (per-unit catalog, pairs), manual sync, sign out.

import { useState } from "react";
import { NumberPad, type PadRequest } from "./NumberPad";
import {
  BAR_CATALOG,
  PLATE_CATALOG,
  getBarKg,
  setBarKg,
  setDefaultRestSeconds,
  setUnit,
  togglePlate,
} from "../lib/settings";
import { formatClock } from "../lib/format";
import { useUnit } from "../hooks/useUnit";
import { useArmed } from "../hooks/useArmed";
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
  const notifSupported = typeof Notification !== "undefined";
  const [notifState, setNotifState] = useState(
    notifSupported ? Notification.permission : "unsupported",
  );
  const [restPad, setRestPad] = useState(false);
  const [armed, setArmed] = useArmed();
  const signOutArmed = armed === "signout";
  if (!open) return null;

  const restPadReq: PadRequest | null = restPad
    ? {
        label: "DEFAULT REST · SECONDS",
        action: "SET REST",
        initial: String(restDefault),
        allowDecimal: false,
        onCommit: (v) => {
          setDefaultRestSeconds(v);
          setRestPad(false);
          toast(`Default rest ${formatClock(Math.min(3600, Math.max(0, Math.round(v))))}`);
        },
        onCancel: () => setRestPad(false),
      }
    : null;

  // the rest strip fires a "Rest over" notification only if permission was
  // granted somewhere — this row is that somewhere (never prompted mid-set)
  const askNotif = () => {
    if (!notifSupported) return;
    Notification.requestPermission()
      .then((p) => {
        setNotifState(p);
        toast(
          p === "granted"
            ? "Rest alerts on"
            : "Rest alerts stay off (browser permission not granted)",
        );
      })
      .catch(() => undefined);
  };

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
          onClick={() => setRestPad(true)}
        >
          <span>
            Default rest <span className="muted-mono">· tap to type</span>
          </span>
          <span className="sheet-row-value">{formatClock(restDefault)}</span>
        </button>

        {notifSupported && (
          <button
            type="button"
            className="sheet-row sheet-row-btn"
            onClick={askNotif}
            disabled={notifState === "granted"}
          >
            <span>Rest alerts</span>
            <span className="sheet-row-value">
              {notifState === "granted"
                ? "ON"
                : notifState === "denied"
                  ? "BLOCKED IN BROWSER"
                  : "TAP TO ENABLE"}
            </span>
          </button>
        )}

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
            toast("Sync started");
          }}
        >
          Sync now
        </button>

        <button
          type="button"
          className={`btn signout-btn ${signOutArmed ? "btn-danger" : "btn-ghost"}`}
          onClick={() => {
            if (!signOutArmed) {
              setArmed("signout");
              return;
            }
            supabase.auth
              .signOut()
              .then(() => onClose())
              .catch((e: unknown) => reportError(e, "sign out"));
          }}
        >
          {signOutArmed ? "Sign out?" : "Sign out"}
        </button>

        {restPadReq && <NumberPad req={restPadReq} />}
      </div>
    </div>
  );
}

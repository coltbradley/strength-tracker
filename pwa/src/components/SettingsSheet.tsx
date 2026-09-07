// Settings sheet. Everything above the DATA section renders from the registry
// in lib/settings.ts — one declaration there produces a labelled, validated,
// resettable row here, so this file needs no edit when a preference is added.
// Only new *control kinds* land in `SettingControl`.
//
// The dialog contract (role=dialog, focus trap, ESC, keyboard inset, scroll)
// belongs to <Sheet>; this file only supplies the title and the rows. The
// number pad opens as a second sheet ON TOP of this one — nested by design,
// and <Sheet> hands key handling to whichever is innermost.

import { useEffect, useState } from "react";
import { NumberPad, type PadRequest } from "./NumberPad";
import { OutboxSheet } from "./OutboxSheet";
import { Sheet } from "./Sheet";
import { TrainingMaxSheet } from "./TrainingMaxSheet";
import {
  GROUP_LABEL,
  GROUP_ORDER,
  MAX_BAR_KG,
  MAX_PLATE_KG,
  addBar,
  addPlate,
  clearExercisePref,
  getBarKg,
  nearKg,
  pruneExercisePrefs,
  removeBar,
  removePlate,
  resetAllSettings,
  setBarKg,
  setLoadStepKg,
  setUnit,
  settingDef,
  settingsInGroup,
  writeSetting,
  type Control,
  type PerUnit,
  type SettingKey,
} from "../lib/settings";
import { formatClock, formatPlate, todayLocalIso } from "../lib/format";
import { useUnit } from "../hooks/useUnit";
import { useArmed } from "../hooks/useArmed";
import { useOutboxStatus } from "../hooks/useOutboxStatus";
import {
  useBarInventory,
  useBarKg,
  useExercisePrefs,
  usePlatesOnHand,
  useSettingRaw,
} from "../hooks/useSettings";
import { fromDisplay, toDisplay, type Unit } from "../lib/units";
import {
  currentTrainingMax,
  getExercises,
  getTrainingMaxes,
} from "../lib/data";
import {
  buildExport,
  downloadText,
  exportFilename,
  toCsv,
} from "../lib/export";
import { outbox } from "../lib/sync";
import { supabase } from "../lib/supabase";
import {
  pushState,
  subscribeToRestAlerts,
  unsubscribeFromRestAlerts,
  type PushState,
} from "../lib/push";
import { reportError, toast } from "../lib/errors";
import { APP_VERSION, BUILD_SHA, BUILD_TIME } from "../lib/build";

interface SettingsSheetProps {
  open: boolean;
  onClose: () => void;
}

/**
 * What signing out actually does to unsynced writes, said exactly, or null
 * when there is nothing outstanding to say it about.
 *
 * This copy used to read "Signing out discards them, this is the only copy",
 * and it was never true. Nothing in the sign-out path touches the outbox:
 * `cacheClearAll` drops the `kv` read cache and the coach thread and leaves
 * the queue alone on purpose, every queued item carries the id of whoever made
 * it, and the flusher holds an item for that person rather than replaying it
 * as anyone else. So the writes survive, they survive under the ACCOUNT that
 * made them, and the button two lines below already said "kept for you" while
 * this block threatened a deletion. A warning that overstates is how a user
 * learns to ignore the ones that are real.
 *
 * The second half is the part that IS destructive and was never mentioned:
 * the cached log on this device goes.
 */
export function signOutCopy(status: {
  pending: number;
  dead: number;
}): string | null {
  const total = status.pending + status.dead;
  if (total === 0) return null;
  const one = total === 1;
  const head = one
    ? "1 write has not reached the server. Signing out does not delete it: it stays on this phone under the account that made it, and goes up the next time that account signs in here."
    : `${total} writes have not reached the server. Signing out does not delete them: they stay on this phone under the account that made each one, and go up the next time that account signs in here.`;
  const cache =
    " The rest of your log is cleared from this device and comes back when you sign in.";
  const tail =
    status.dead === 0
      ? " Tap “Sync now” first if you have signal."
      : status.dead === 1
        ? " One of them has failed and will not go on its own: open Unsynced writes and retry or export it first."
        : ` ${status.dead} of them have failed and will not go on their own: open Unsynced writes and retry or export them first.`;
  return head + cache + tail;
}

type OpenPad = (req: PadRequest) => void;

export function SettingsSheet({ open, onClose }: SettingsSheetProps) {
  const unit = useUnit();
  const status = useOutboxStatus();
  const [armed, setArmed] = useArmed();
  const [pad, setPad] = useState<PadRequest | null>(null);
  const [exerciseNames, setExerciseNames] = useState<Record<string, string>>(
    {},
  );
  const [busy, setBusy] = useState(false);
  const [tmOpen, setTmOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  // count of training maxes actually IN FORCE today (a future-dated row is
  // scheduled, not current — same rule as v_current_tm); null = not read yet
  const [tmCount, setTmCount] = useState<number | null>(null);

  const notifSupported = typeof Notification !== "undefined";
  const [notifState, setNotifState] = useState(
    notifSupported ? Notification.permission : "unsupported",
  );
  // Closed-app alerts: read from the browser's push manager each time the
  // sheet opens, never remembered — null until it has answered.
  const [pushSt, setPushSt] = useState<PushState | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    pushState()
      .then((s) => {
        if (!cancelled) setPushSt(s);
      })
      .catch((e: unknown) => reportError(e, "rest alert state"));
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Names for the per-exercise override list, and the one chance this app gets
  // to garbage-collect overrides whose exercise is gone. Never prune off an
  // empty result — that would be an offline read, not an empty library.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getExercises()
      .then(({ data }) => {
        if (cancelled || data.length === 0) return;
        setExerciseNames(Object.fromEntries(data.map((e) => [e.id, e.name])));
        const dropped = pruneExercisePrefs(data.map((e) => e.id));
        if (dropped > 0) {
          toast(
            `Cleared ${dropped} override(s) for exercises that no longer exist`,
          );
        }
      })
      .catch((e: unknown) => reportError(e, "load exercises"));
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Training-max count for the row below. Re-read whenever the TM sheet
  // closes, so setting one updates the number behind it.
  useEffect(() => {
    if (!open || tmOpen) return;
    let cancelled = false;
    const today = todayLocalIso();
    getTrainingMaxes()
      .then(({ data }) => {
        if (cancelled) return;
        const ids = new Set(data.map((r) => r.exercise_id));
        setTmCount(
          [...ids].filter(
            (id) =>
              currentTrainingMax(
                data.filter((r) => r.exercise_id === id),
                today,
              ) !== null,
          ).length,
        );
      })
      .catch(() => setTmCount(null));
    return () => {
      cancelled = true;
    };
  }, [open, tmOpen]);

  if (!open) return null;

  const openPad: OpenPad = (req) =>
    setPad({
      ...req,
      onCommit: (v) => {
        req.onCommit(v);
        setPad(null);
      },
      onCancel: () => setPad(null),
    });

  // the rest strip fires a "Rest over" notification only if permission was
  // granted somewhere — this row is that somewhere (never prompted mid-set)
  const askNotif = () => {
    if (!notifSupported) return;
    Notification.requestPermission()
      .then((p) => {
        setNotifState(p);
        // "on" was a promise this row cannot keep: the permission is the
        // browser's answer about permission, not about delivery.
        toast(
          p === "granted"
            ? "Rest alerts allowed — the rest sound is the reliable one"
            : "Rest alerts stay off (browser permission not granted)",
        );
      })
      .catch(() => undefined);
  };

  const runExport = (kind: "json" | "csv") => {
    setBusy(true);
    buildExport(APP_VERSION)
      .then((bundle) => {
        if (kind === "json") {
          downloadText(
            exportFilename("json"),
            "application/json",
            JSON.stringify(bundle, null, 2),
          );
        } else {
          downloadText(exportFilename("csv"), "text/csv", toCsv(bundle));
        }
        toast(`Exported ${bundle.sets.length} sets`);
      })
      .catch((e: unknown) => reportError(e, "export"))
      .finally(() => setBusy(false));
  };

  const queued = status.pending + status.dead;
  // Two taps, and the second states the count when there is unsynced work.
  //
  // This used to be THREE taps, the last one reading "Discard unsynced sets and
  // sign out" — which was never what happened: nothing dropped the outbox, and
  // signing back in flushed it. Since multi-user it is true in the other
  // direction as well. Every queued write is stamped with its owner, the
  // flusher refuses to replay one person's writes as another, and signing out
  // clears the read cache but never the outbox. So the sets are genuinely kept
  // for whoever queued them, and the button should say so instead of
  // threatening a deletion it does not perform.
  const signOutStage = armed === "signout" ? 1 : 0;
  const signOutLabel =
    signOutStage === 0
      ? "Sign out"
      : queued > 0
        ? `${queued} unsynced, kept for you. Sign out?`
        : "Sign out?";
  const signOutWarning = signOutStage > 0 ? signOutCopy(status) : null;

  const signOut = () => {
    if (signOutStage === 0) {
      setArmed("signout");
      return;
    }
    supabase.auth
      .signOut()
      .then(() => onClose())
      .catch((e: unknown) => reportError(e, "sign out"));
  };

  return (
    <Sheet title="SETTINGS" onClose={onClose}>
      {GROUP_ORDER.map((group) => {
        const keys = settingsInGroup(group);
        if (keys.length === 0) return null;
        return (
          <section key={group} className="settings-group">
            <div className="field-label">{GROUP_LABEL[group]}</div>
            {keys.map((key) => (
              <SettingControl
                key={key}
                settingKey={key}
                unit={unit}
                openPad={openPad}
              />
            ))}
            {group === "gym" && (
              <ExerciseOverrides names={exerciseNames} unit={unit} />
            )}
            {/* This row used to be HIDDEN where notifications are impossible,
                which read as "nothing to configure here" — and worse, on a
                browser that exposes the API without delivering anything it
                reported ON for a cue that could never fire. A settings screen
                that reports success for something that cannot happen is the
                one thing it must never do. Both states now say so, and both
                point at the tone above, which is what actually rings. */}
            {group === "timing" &&
              (notifSupported ? (
                <>
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
                  <div className="microcopy">
                    A system notification when rest runs out, while the app is
                    open. Some browsers grant the permission and then deliver
                    nothing — an iPhone home-screen app is the usual case — so
                    keep the rest sound on as the cue you can rely on. The row
                    below is what reaches a locked phone.
                  </div>
                </>
              ) : (
                <>
                  <div className="sheet-row">
                    <span>Rest alerts</span>
                    <span className="sheet-row-value muted">NOT SUPPORTED</span>
                  </div>
                  <div className="microcopy">
                    This browser has no notification API, so nothing outside the
                    app can announce the end of rest. The rest sound above is
                    the alert, and the screen stays awake while a session is
                    open.
                  </div>
                </>
              ))}
            {group === "timing" && (
              <ClosedAppAlerts state={pushSt} onChange={setPushSt} />
            )}
          </section>
        );
      })}

      {/* Not a device preference like everything above: these rows live in
          Postgres and Claude reads the same numbers. The section label says
          so, and the microcopy repeats it, because the rest of this sheet has
          taught the user that settings never leave the phone. */}
      <section className="settings-group">
        <div className="field-label">TRAINING</div>
        <button
          type="button"
          className="sheet-row sheet-row-btn"
          onClick={() => setTmOpen(true)}
        >
          <span>Training maxes</span>
          <span className="sheet-row-value">
            {tmCount === null
              ? "OPEN"
              : tmCount === 0
                ? "NONE SET"
                : `${tmCount} SET`}
          </span>
        </button>
        <div className="microcopy">
          What a “% TM” prescription resolves against. Dated values, stored on
          the server — not on this device with the rest of these settings.
        </div>
      </section>

      <section className="settings-group">
        <div className="field-label">DATA</div>

        <button
          type="button"
          className="sheet-row sheet-row-btn"
          onClick={() => {
            void outbox.flush();
            toast("Sync started");
          }}
        >
          <span>Sync now</span>
          <span className="sheet-row-value">
            {queued > 0 ? `${queued} QUEUED` : "UP TO DATE"}
          </span>
        </button>

        {/* Sync now is the ACTION; this is the account of what it is acting
            on. They show different numbers on purpose: the queue's total is
            above, and this row names the part of it that will not move on its
            own, which is the only part worth a trip. */}
        <button
          type="button"
          className="sheet-row sheet-row-btn"
          onClick={() => setQueueOpen(true)}
        >
          <span>Unsynced writes</span>
          <span className="sheet-row-value">
            {queued === 0
              ? "NONE"
              : status.dead > 0
                ? `${status.dead} FAILED`
                : status.held > 0
                  ? `${status.held} HELD`
                  : `${queued} WAITING`}
          </span>
        </button>
        <div className="microcopy">
          What has not reached the server, why, and how to get a copy off this
          phone. The queue holds the only copy of a set until it lands.
        </div>

        <button
          type="button"
          className="sheet-row sheet-row-btn"
          onClick={() => runExport("json")}
          disabled={busy}
        >
          <span>Export JSON</span>
          <span className="sheet-row-value">
            {busy ? "WORKING…" : "SESSIONS + SETS"}
          </span>
        </button>

        <button
          type="button"
          className="sheet-row sheet-row-btn"
          onClick={() => runExport("csv")}
          disabled={busy}
        >
          <span>Export CSV</span>
          <span className="sheet-row-value">
            {busy ? "WORKING…" : "ONE ROW PER SET"}
          </span>
        </button>

        <div className="sheet-row">
          <span>Version</span>
          <span className="sheet-row-value">
            {APP_VERSION}
            {BUILD_SHA ? ` · ${BUILD_SHA.slice(0, 7)}` : ""}
          </span>
        </div>
        <div className="microcopy">
          {BUILD_TIME ? `Built ${BUILD_TIME}. ` : ""}
          {import.meta.env.MODE} build. The app updates itself in the
          background, so this number can change without asking.
        </div>
      </section>

      <section className="settings-group settings-danger">
        <div className="field-label">DANGER</div>

        <button
          type="button"
          className={`btn ${armed === "reset" ? "btn-danger" : "btn-ghost"}`}
          onClick={() => {
            if (armed !== "reset") {
              setArmed("reset");
              return;
            }
            resetAllSettings();
            setArmed(null);
            toast("Settings back to defaults");
          }}
        >
          {armed === "reset"
            ? "Reset every setting?"
            : "Reset settings to defaults"}
        </button>
        <div className="microcopy">
          Preferences only. Logged sessions and sets are never touched.
        </div>

        {signOutWarning !== null && (
          <div className="microcopy settings-warn">{signOutWarning}</div>
        )}

        <button
          type="button"
          className={`btn signout-btn ${signOutStage > 0 ? "btn-danger" : "btn-ghost"}`}
          onClick={signOut}
        >
          {signOutLabel}
        </button>
      </section>

      {tmOpen && <TrainingMaxSheet onClose={() => setTmOpen(false)} />}
      {queueOpen && <OutboxSheet onClose={() => setQueueOpen(false)} />}
      {pad && <NumberPad req={pad} />}
    </Sheet>
  );
}

// ---- closed-app rest alerts (6f) ---------------------------------------------

/**
 * "Alert me when the app is closed": a Web Push sent by the server at the
 * deadline (lib/push.ts). Four honest states, and the row never reports ON for
 * something that cannot arrive: the state is read from the browser's push
 * manager, not remembered.
 */
function ClosedAppAlerts({
  state,
  onChange,
}: {
  state: PushState | null;
  onChange: (s: PushState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const actionable = state === "on" || state === "off";

  const toggle = () => {
    if (busy || !actionable) return;
    setBusy(true);
    (state === "on" ? unsubscribeFromRestAlerts() : subscribeToRestAlerts())
      .then((s) => {
        onChange(s);
        if (s === "on") toast("Closed-app rest alerts on for this phone");
        else if (state === "on") toast("Closed-app rest alerts off");
      })
      .catch((e: unknown) => reportError(e, "rest alerts"))
      .finally(() => setBusy(false));
  };

  const value =
    state === null
      ? "…"
      : busy
        ? "WORKING…"
        : state === "unsupported"
          ? "NOT AVAILABLE"
          : state === "denied"
            ? "BLOCKED"
            : state === "on"
              ? "ON"
              : "OFF";

  const copy =
    state === "unsupported"
      ? "Needs the app installed to the Home Screen. In Safari: Share → Add to Home Screen, then open it from there and come back to this row."
      : state === "denied"
        ? "Notifications are blocked for this app. Allow them in iOS Settings → Notifications (or the browser's site settings), then come back."
        : state === "on"
          ? "On for this phone. When rest runs out with the app closed or the screen locked, the server sends a notification; logging the next set first cancels it. Some rests are too long for the server to hold, and the app says so once."
          : "A notification when rest runs out even with the phone locked or the app closed — sent by the server at the deadline, cancelled by your next set. Tap to allow notifications and turn it on.";

  return (
    <>
      <button
        type="button"
        className="sheet-row sheet-row-btn"
        onClick={toggle}
        disabled={!actionable || busy}
      >
        <span>Alert me when the app is closed</span>
        <span
          className={`sheet-row-value ${state === "unsupported" ? "muted" : ""}`}
        >
          {value}
        </span>
      </button>
      <div className="microcopy">{copy}</div>
    </>
  );
}

// ---- registry-driven controls ----------------------------------------------

function SettingControl({
  settingKey,
  unit,
  openPad,
}: {
  settingKey: SettingKey;
  unit: Unit;
  openPad: OpenPad;
}) {
  const def = settingDef(settingKey);
  const value = useSettingRaw(settingKey);
  const control: Control = def.control;

  const body = (() => {
    switch (control.kind) {
      case "hidden":
        return null;

      case "segment":
        return (
          <div className="sheet-row">
            <span>{def.label}</span>
            <div className="seg">
              {control.options.map((o) => (
                <button
                  key={String(o.value)}
                  type="button"
                  className={`seg-btn ${o.value === value ? "seg-on" : ""}`}
                  onClick={() => {
                    // the unit switch also repairs bar selections; go through
                    // the dedicated setter rather than the generic one
                    if (settingKey === "unit") setUnit(o.value as Unit);
                    else writeSetting(settingKey, o.value);
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        );

      case "toggle":
        return (
          <div className="sheet-row">
            <span>{def.label}</span>
            <div className="seg">
              {[false, true].map((v) => (
                <button
                  key={String(v)}
                  type="button"
                  className={`seg-btn ${value === v ? "seg-on" : ""}`}
                  onClick={() => writeSetting(settingKey, v)}
                >
                  {v ? "ON" : "OFF"}
                </button>
              ))}
            </div>
          </div>
        );

      case "seconds":
        return (
          <PadRow
            label={def.label}
            display={formatClock(value as number)}
            onOpen={() =>
              openPad({
                label: `${def.label.toUpperCase()} · SECONDS`,
                action: "SET",
                initial: String(value as number),
                allowDecimal: false,
                onCommit: (v) =>
                  commit(
                    settingKey,
                    Math.round(v),
                    control.min,
                    control.max,
                    def.label,
                  ),
                onCancel: () => undefined,
              })
            }
          />
        );

      case "count":
        return (
          <PadRow
            label={def.label}
            display={String(value as number)}
            onOpen={() =>
              openPad({
                label: def.label.toUpperCase(),
                action: "SET",
                initial: String(value as number),
                allowDecimal: false,
                onCommit: (v) =>
                  commit(
                    settingKey,
                    Math.round(v),
                    control.min,
                    control.max,
                    def.label,
                  ),
                onCancel: () => undefined,
              })
            }
          />
        );

      case "load":
        return (
          <PadRow
            label={def.label}
            display={`${toDisplay(value as number, unit)} ${unit}`}
            onOpen={() =>
              openPad({
                label: `${def.label.toUpperCase()} · ${unit.toUpperCase()}`,
                action: "SET",
                initial: String(toDisplay(value as number, unit)),
                allowDecimal: true,
                onCommit: (v) =>
                  commit(
                    settingKey,
                    fromDisplay(v, unit),
                    control.min,
                    control.max,
                    def.label,
                  ),
                onCancel: () => undefined,
              })
            }
          />
        );

      case "loadPerUnit": {
        const per = value as PerUnit<number>;
        const fine = settingKey === "loadStepFine";
        return (
          <PadRow
            label={`${def.label} · ${unit}`}
            display={`± ${toDisplay(per[unit], unit)} ${unit}`}
            onOpen={() =>
              openPad({
                label: `${def.label.toUpperCase()} · ${unit.toUpperCase()}`,
                action: "SET",
                initial: String(toDisplay(per[unit], unit)),
                allowDecimal: true,
                onCommit: (v) => {
                  const kg = fromDisplay(v, unit);
                  if (kg < control.min || kg > control.max) {
                    toast(`${def.label} must be a positive load`, "error");
                    return;
                  }
                  if (!setLoadStepKg(unit, fine, kg)) {
                    toast(`${def.label} rejected`, "error");
                  }
                },
                onCancel: () => undefined,
              })
            }
          />
        );
      }

      case "plateInventory":
        return (
          <PlateInventory label={def.label} unit={unit} openPad={openPad} />
        );

      case "barInventory":
        return <BarInventory label={def.label} unit={unit} openPad={openPad} />;
    }
  })();

  if (body === null) return null;
  return (
    <div className="setting-block">
      {body}
      {def.help && <div className="microcopy">{def.help}</div>}
    </div>
  );
}

function commit(
  key: SettingKey,
  value: number,
  min: number,
  max: number,
  label: string,
): void {
  const clamped = Math.min(max, Math.max(min, value));
  if (!writeSetting(key, clamped)) {
    toast(`${label} rejected`, "error");
  }
}

function PadRow({
  label,
  display,
  onOpen,
}: {
  label: string;
  display: string;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="sheet-row sheet-row-btn" onClick={onOpen}>
      <span>
        {label} <span className="muted-mono">· tap to type</span>
      </span>
      <span className="sheet-row-value">{display}</span>
    </button>
  );
}

// ---- inventories -----------------------------------------------------------

function PlateInventory({
  label,
  unit,
  openPad,
}: {
  label: string;
  unit: Unit;
  openPad: OpenPad;
}) {
  const plates = usePlatesOnHand(unit);
  const smallest = plates.length > 0 ? Math.min(...plates) : null;

  return (
    <div className="sheet-row sheet-row-stack">
      <span>
        {label} <span className="muted-mono">· {unit} · tap to remove</span>
      </span>
      <div className="chip-row">
        {plates.map((p) => (
          <button
            key={p}
            type="button"
            className="chip chip-on"
            onClick={() => removePlate(unit, p)}
            aria-label={`remove ${formatPlate(p, unit)} ${unit} plate`}
          >
            {formatPlate(p, unit)} ×
          </button>
        ))}
        <button
          type="button"
          className="chip"
          onClick={() =>
            openPad({
              label: `ADD PLATE · ${unit.toUpperCase()}`,
              action: "ADD PLATE",
              initial: "",
              allowDecimal: true,
              onCommit: (v) => {
                if (!addPlate(unit, fromDisplay(v, unit))) {
                  toast(
                    `Plate must be between 0 and ${toDisplay(MAX_PLATE_KG, unit)} ${unit} and not already on the list`,
                    "error",
                  );
                }
              },
              onCancel: () => undefined,
            })
          }
        >
          + ADD
        </button>
      </div>
      <div className="microcopy">
        {smallest === null
          ? "No plates on hand — the calculator will only offer the bar."
          : `Smallest jump ${toDisplay(smallest * 2, unit)} ${unit} — plates load in pairs.`}
      </div>
    </div>
  );
}

function BarInventory({
  label,
  unit,
  openPad,
}: {
  label: string;
  unit: Unit;
  openPad: OpenPad;
}) {
  const bars = useBarInventory(unit);
  const selected = useBarKg(unit);

  return (
    <div className="sheet-row sheet-row-stack">
      <span>
        {label} <span className="muted-mono">· {unit} · tap to select</span>
      </span>
      <div className="chip-row">
        {bars.map((b) => (
          <button
            key={b}
            type="button"
            className={`chip ${nearKg(b, selected) ? "chip-on" : ""}`}
            onClick={() => setBarKg(unit, b)}
          >
            BAR {toDisplay(b, unit)}
          </button>
        ))}
        <button
          type="button"
          className="chip"
          onClick={() =>
            openPad({
              label: `ADD BAR · ${unit.toUpperCase()}`,
              action: "ADD BAR",
              initial: "",
              allowDecimal: true,
              onCommit: (v) => {
                if (!addBar(unit, fromDisplay(v, unit))) {
                  toast(
                    `Bar must be between 0 and ${toDisplay(MAX_BAR_KG, unit)} ${unit} and not already on the list`,
                    "error",
                  );
                }
              },
              onCancel: () => undefined,
            })
          }
        >
          + ADD
        </button>
        {bars.length > 1 && (
          <button
            type="button"
            className="chip"
            onClick={() => {
              if (!removeBar(unit, getBarKg(unit))) {
                toast("Keep at least one bar", "error");
              }
            }}
          >
            REMOVE {toDisplay(selected, unit)}
          </button>
        )}
      </div>
    </div>
  );
}

// ---- per-exercise overrides ------------------------------------------------

function ExerciseOverrides({
  names,
  unit,
}: {
  names: Record<string, string>;
  unit: Unit;
}) {
  const prefs = useExercisePrefs();
  if (prefs.length === 0) return null;

  return (
    <div className="sheet-row sheet-row-stack">
      <span>
        Exercise overrides{" "}
        <span className="muted-mono">· set from the plate sheet</span>
      </span>
      {prefs.map(({ exerciseId, pref }) => {
        const parts: string[] = [];
        if (pref.barKg !== undefined) {
          parts.push(
            pref.barKg === 0
              ? "NO BAR"
              : `BAR ${formatPlate(pref.barKg, unit)}`,
          );
        }
        if (pref.restSeconds !== undefined) {
          parts.push(`REST ${formatClock(pref.restSeconds)}`);
        }
        if (pref.loadStepKg !== undefined) {
          parts.push(`± ${toDisplay(pref.loadStepKg, unit)}`);
        }
        return (
          <button
            key={exerciseId}
            type="button"
            className="sheet-row sheet-row-btn override-row"
            onClick={() => {
              clearExercisePref(exerciseId);
              toast("Override cleared");
            }}
          >
            <span>{names[exerciseId] ?? exerciseId}</span>
            <span className="sheet-row-value">{parts.join(" · ")} · CLEAR</span>
          </button>
        );
      })}
    </div>
  );
}

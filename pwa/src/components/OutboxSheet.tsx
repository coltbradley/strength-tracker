// The write queue, made visible.
//
// The outbox holds the ONLY copy of a set that has not reached the server, and
// until this sheet existed it said nothing about itself: a topbar pill counted
// items and a "RETRY" button re-queued every dead one blindly, including the
// ones the server refuses on the merits of the row and will refuse again. Two
// states were entirely silent — an item HELD because a different account
// queued it, and an item DEAD because the row itself is not acceptable — and
// someone could sign out with unsynced training on the device and never be
// told which of those it was.
//
// WHY ITS OWN SHEET, not a section in Settings. Settings renders from the
// settings registry, is already ~2000px tall, and is a list of PREFERENCES;
// this is a list of RECORDS, with per-item state, an age, a reason and two
// actions. It follows TrainingMaxSheet's precedent exactly: a one-line row in
// Settings that opens the real surface, so the sheet is reachable from every
// screen through the gear. It is also reachable from the topbar pill, which is
// where the problem is actually felt.
//
// TONE. Three items syncing on gym wifi is the ordinary state of an
// offline-first app and must not read as an alarm: with nothing held and
// nothing failed, this sheet is a count and a sentence saying the queue is
// doing its job. The colour and the ranking only appear when something is
// genuinely stuck.
//
// A narrow recovery for an authored-load consistency rejection can remove the
// contradictory provenance from an unsent set after export and review. The
// logged total, set id and training fields stay as the lifter recorded them.

import { useCallback, useEffect, useState } from "react";
import { Sheet } from "./Sheet";
import { outbox } from "../lib/sync";
import { useOutboxStatus } from "../hooks/useOutboxStatus";
import { getExercises } from "../lib/data";
import { buildQueueExport, downloadText, exportFilename } from "../lib/export";
import { reportError, toast } from "../lib/errors";
import { APP_VERSION } from "../lib/build";
import { useUnit } from "../hooks/useUnit";
import { toDisplay } from "../lib/units";
import type { DeadKind, OutboxEntry } from "../lib/outbox";
import type { OutboxOp } from "../lib/db";

/** Rows shown per group. The export carries every one of them, so a long
 *  offline session is not a reason to make this sheet unscrollable. */
const LIST_CAP = 25;

/**
 * How old the oldest queued write is, terse enough for a mono value cell.
 * Ages are the one number here that answers "should I be worried": four
 * minutes is a flush in progress, four days is a phone that has not been
 * online since.
 */
export function formatAge(ms: number): string {
  if (ms < 60_000) return "JUST NOW";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} MIN`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}H`;
  return `${Math.floor(hours / 24)}D`;
}

/**
 * What one queued write IS, in the words the app uses everywhere else. The
 * table name is the app's vocabulary, not the lifter's, and "set_voids" on a
 * screen someone reaches while worried is not an answer.
 */
export function describeOp(
  op: OutboxOp,
  exerciseNames: Record<string, string>,
  state?: OutboxEntry["state"],
): string {
  if (op.kind === "update") {
    if (op.table === "symptom_episodes") return "Injury cleared up";
    if ("discarded_at" in op.patch) {
      if (state === "dead") return "Discard refused";
      if (state) return "Discard pending";
      return "Session discarded";
    }
    // A rating given from Today carries session_rpe and nothing else. A finish
    // carries ended_at and MAY carry a rating alongside it, and what that write
    // did was end the session — so ended_at decides, not the rating.
    return "ended_at" in op.patch ? "Session ended" : "Session rated";
  }
  switch (op.table) {
    case "sessions":
      return "Session started";
    case "set_voids":
      return "Set removed";
    case "set_notes":
      return "Set note";
    case "bodyweight_log":
      return "Weigh-in";
    // The subjective-capture rows. Named for what the lifter did, not for the
    // table: this sheet is read by someone worried a write has not landed, and
    // "daily_readiness" is not an answer to that worry.
    case "daily_readiness":
      return "Morning check-in";
    case "checkins":
      return "Check-in";
    case "symptom_episodes":
      return "Injury started";
    case "pain_checks":
      return "Pain check";
    case "report_prompts":
      // The row records that we ASKED, and `skipped` says how it went. A skip
      // is the interesting one — it is the fact that stops the app asking
      // again — so it gets its own words rather than being folded in.
      return op.payload.skipped ? "Check-in skipped" : "Check-in prompt";
    case "sets": {
      const name = exerciseNames[op.payload.exercise_id];
      return name === undefined ? "Set logged" : `Set · ${name}`;
    }
    case "feedback":
      return "Problem report";
    case "session_skips":
      return op.payload.scope === "warmups"
        ? "Warmups skipped"
        : "Exercise skipped";
  }
}

/** One sentence per reason a write is parked, said to the person whose set it
 *  is. `cause` comes from the recorded code and status, so these are claims
 *  the app can actually stand behind. */
const CAUSE_COPY: Record<DeadKind, string> = {
  auth: "Refused because there was no valid session. Signing in again is what fixes these.",
  blocked:
    "Refused by the server's permission rules, or waiting on a row above it in the queue that has not landed. Retrying can still work.",
  rejected:
    "The server rejected the row itself. Sending the same thing again gets the same answer, so retry does not offer to. Export keeps your copy.",
  unknown:
    "The cause was not recorded. Retry is offered because a guess that refuses to try is the worse guess.",
};

export function OutboxSheet({ onClose }: { onClose: () => void }) {
  const unit = useUnit();
  const status = useOutboxStatus();
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [reviewKey, setReviewKey] = useState<number | null>(null);
  const [exportedSnapshot, setExportedSnapshot] = useState<OutboxEntry[] | null>(null);
  const [savedExport, setSavedExport] = useState(false);

  const reload = useCallback(() => {
    outbox
      .inspect()
      .then((rows) => {
        setEntries(rows);
        setNow(Date.now());
      })
      .catch((e: unknown) => reportError(e, "read the write queue"));
  }, []);

  // Re-read whenever the queue moves. The status object is the outbox's own
  // change signal, so a flush landing behind this sheet updates it rather than
  // leaving a stale list on screen.
  useEffect(reload, [reload, status.pending, status.dead, status.held]);

  // Names for the set rows and for the export. Cached, so this works offline,
  // which is the condition someone opens this sheet in.
  useEffect(() => {
    let cancelled = false;
    getExercises()
      .then(({ data }) => {
        if (cancelled || data.length === 0) return;
        setNames(Object.fromEntries(data.map((e) => [e.id, e.name])));
      })
      .catch((e: unknown) => reportError(e, "load exercises"));
    return () => {
      cancelled = true;
    };
  }, []);

  const dead = entries.filter((e) => e.state === "dead");
  const held = entries.filter((e) => e.state === "held");
  const waiting = entries.filter((e) => e.state === "waiting");
  const queuedSetIds = new Set(entries.flatMap((e) =>
    e.op.kind === "insert" && e.op.table === "sets" ? [e.op.payload.id] : []));
  const retryable = dead.filter((e) => e.retryable && !(e.op.kind === "insert" &&
    (e.op.table === "set_voids" || e.op.table === "set_notes") &&
    queuedSetIds.has(e.op.payload.set_id)));
  const blockedSetChanges = dead.filter(
    (e) => e.cause === "blocked" && e.op.kind === "insert" &&
      (e.op.table === "set_voids" || e.op.table === "set_notes"),
  );
  const repairable = dead.filter((e) => e.loadRepairable === true);
  const review = repairable.find((e) => e.key === reviewKey);
  const reviewTotal = review?.op.kind === "insert" && review.op.table === "sets"
    ? `${unit === "kg" ? review.op.payload.load_kg : toDisplay(review.op.payload.load_kg, unit)} ${unit}`
    : null;
  // A saved export can cover more than one repaired set. The queue changes
  // after the first retry, but an untouched row is still the exact row the
  // lifter saved and reviewed. The outbox checks it again before mutation.
  const exportMatches = Boolean(review && exportedSnapshot?.some((saved) =>
    saved.key === review.key &&
    saved.user_id === review.user_id &&
    saved.created_at === review.created_at &&
    JSON.stringify(saved.op) === JSON.stringify(review.op)
  ));
  const batchMatches = repairable.length > 1 && Boolean(exportedSnapshot &&
    repairable.every((row) => exportedSnapshot.some((saved) =>
      saved.key === row.key && saved.user_id === row.user_id &&
      saved.created_at === row.created_at &&
      JSON.stringify(saved.op) === JSON.stringify(row.op))));
  const oldest = entries.reduce<number | null>((acc, e) => {
    if (e.created_at === null) return acc;
    const t = Date.parse(e.created_at);
    if (Number.isNaN(t)) return acc;
    return acc === null || t < acc ? t : acc;
  }, null);

  const retry = () => {
    setBusy(true);
    outbox
      .retryDead()
      .then(({ requeued, stuck }) => {
        toast(
          requeued === 0
            ? "Nothing here can be retried. Export keeps your copy."
            : `Retrying ${requeued}` +
                (stuck > 0 ? `. ${stuck} cannot be sent as queued.` : ""),
        );
        reload();
      })
      .catch((e: unknown) => reportError(e, "retry failed writes"))
      .finally(() => setBusy(false));
  };

  const runExport = () => {
    setBusy(true);
    const saveSnapshot = async (rows: OutboxEntry[]) => {
      const current = await outbox.inspect();
      if (JSON.stringify(current) !== JSON.stringify(rows)) {
        toast("The queue changed during export. Export it again before repair.");
        return;
      }
      setExportedSnapshot(rows);
      setSavedExport(false);
      toast(`Queue copy prepared for ${rows.length} writes. Confirm you saved the file.`);
    };

    // Installed iOS web apps have had Blob-link downloads silently fail. A
    // native file share gives the lifter a Save to Files choice. It must be
    // called during the click's user activation, before an IndexedDB await.
    const rows = entries;
    const bundle = buildQueueExport(rows, names, APP_VERSION);
    const filename = exportFilename("json", "unsynced");
    const json = JSON.stringify(bundle, null, 2);
    const file = new File([json], filename, { type: "application/json" });
    let canShareFile = false;
    try {
      canShareFile = Boolean(typeof navigator.share === "function" && navigator.canShare?.({ files: [file] }));
    } catch {
      // A file type unsupported by this browser falls back to a download.
    }
    if (canShareFile) {
      navigator
        .share({ files: [file], title: "Strength log write queue" })
        .then(() => saveSnapshot(rows))
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === "AbortError") return;
          reportError(e, "share the write queue");
        })
        .finally(() => setBusy(false));
      return;
    }
    outbox
      .inspect()
      .then((current) => {
        const currentBundle = buildQueueExport(current, names, APP_VERSION);
        downloadText(filename, "application/json", JSON.stringify(currentBundle, null, 2));
        return saveSnapshot(current);
      })
      .catch((e: unknown) => reportError(e, "export the write queue"))
      .finally(() => setBusy(false));
  };

  const repairReviewed = () => {
    if (
      !review ||
      review.op.kind !== "insert" ||
      review.op.table !== "sets" ||
      !exportMatches ||
      !savedExport
    ) return;
    setBusy(true);
    outbox
      .repairDeadLoadSet(review.key, review.op.payload)
      .then((repaired) => {
        if (repaired) {
          toast("Set queued for retry with its logged total; check sync status for delivery.");
          setReviewKey(null);
          setSavedExport(false);
        } else {
          toast("This set changed or belongs to another account. Export and review it again.");
        }
        reload();
      })
      .catch((e: unknown) => reportError(e, "repair failed set"))
      .finally(() => setBusy(false));
  };

  const repairAllReviewed = () => {
    if (!batchMatches || !savedExport || !exportedSnapshot) return;
    const selected = exportedSnapshot.filter((row) => repairable.some((current) => current.key === row.key));
    setBusy(true);
    outbox.repairDeadLoadSets(selected)
      .then((repaired) => {
        if (repaired) {
          toast(`${selected.length} sets queued for retry. Check sync status before retrying linked writes.`);
          setSavedExport(false);
          setExportedSnapshot(null);
        } else {
          toast("The queue or account changed. Export and review it again; no sets were repaired.");
          setSavedExport(false);
          setExportedSnapshot(null);
        }
        reload();
      })
      .catch((e: unknown) => reportError(e, "repair failed sets"))
      .finally(() => setBusy(false));
  };

  return (
    <Sheet title="UNSYNCED WRITES" onClose={onClose}>
      <section className="settings-group">
        <div className="field-label">ON THIS PHONE</div>

        <div className="sheet-row">
          <span>Waiting to sync</span>
          <span className="sheet-row-value">{waiting.length}</span>
        </div>
        {held.length > 0 && (
          <div className="sheet-row">
            <span>Held for another account</span>
            <span className="sheet-row-value queue-state-held">
              {held.length}
            </span>
          </div>
        )}
        {dead.length > 0 && (
          <div className="sheet-row">
            <span>Failed</span>
            <span className="sheet-row-value queue-state-dead">
              {dead.length}
            </span>
          </div>
        )}
        {oldest !== null && (
          <div className="sheet-row">
            <span>Oldest</span>
            <span className="sheet-row-value">
              {formatAge(Math.max(0, now - oldest))}
            </span>
          </div>
        )}

        <div className="microcopy">
          {entries.length === 0
            ? "Nothing is waiting. Everything you have logged is on the server."
            : dead.length === 0 && held.length === 0
              ? "Queued on this phone until it can reach the server. This is the normal state offline, and nothing is lost while it waits."
              : "These writes are on this phone and nowhere else. Nothing below is deleted by leaving this screen, by signing out, or by an app update."}
        </div>
      </section>

      {dead.length > 0 && (
        <section className="settings-group">
          <div className="field-label">FAILED ({dead.length})</div>
          <QueueList entries={dead} names={names} now={now} />
          {[...new Set(dead.map((e) => e.cause))].map(
            (cause) =>
              cause !== null && (
                <div key={cause} className="microcopy">
                  {CAUSE_COPY[cause]}
                </div>
              ),
          )}
          {blockedSetChanges.length > 0 && (
            <div className="microcopy">
              A set removal or note may be waiting on its set. After the set
              syncs, use Retry failed below to send these linked writes. If
              they are still refused, keep the queue export for review.
            </div>
          )}
        </section>
      )}

      {repairable.length > 0 && (
        <section className="settings-group">
          <div className="field-label">LOAD REPAIR ({repairable.length})</div>
          <div className="microcopy">
            These sets were refused because the saved total and stored entered fields
            disagree. Export the queue, then review every total before retrying.
            Repair keeps the logged total in kg and marks the
            stored entered number and unit as unknown. The export keeps the
            original queued row.
          </div>
          {repairable.length > 1 && (
            <div className="queue-repair-review">
              <div className="field-label">REVIEW ALL {repairable.length} SETS</div>
              {repairable.map((row) => row.op.kind === "insert" && row.op.table === "sets" && (
                <div key={row.key}>
                  {names[row.op.payload.exercise_id] ?? "Set logged"} · set {row.op.payload.set_index + 1}: {row.op.payload.load_kg} kg total
                  {unit !== "kg" ? ` (${toDisplay(row.op.payload.load_kg, unit)} ${unit} total)` : ""}
                  {row.op.payload.load_entry === "per_side" ? `, ${toDisplay(row.op.payload.load_kg / 2, unit)} ${unit}/side` : ""}
                  {` · ID ${row.op.payload.id}`}
                </div>
              ))}
              <div className="microcopy">The original entered numbers and units remain in the saved export. All {repairable.length} sets keep their IDs, owners, times, indexes, totals and other training values. Linked removals and notes need a separate retry after these sets sync.</div>
              <label>
                <input type="checkbox" checked={savedExport} onChange={(event) => setSavedExport(event.target.checked)} disabled={!batchMatches || busy} />
                I saved the queue export and checked all {repairable.length} totals
              </label>
              <button type="button" className="btn btn-ghost" onClick={repairAllReviewed} disabled={busy || !batchMatches || !savedExport}>
                Repair all {repairable.length} sets and retry
              </button>
            </div>
          )}
          {repairable.length === 1 && <>
          {repairable.map((e, index) => {
            const set = e.op.kind === "insert" && e.op.table === "sets"
              ? e.op.payload
              : null;
            return (
              <button
                key={e.key}
                type="button"
                className="btn btn-ghost"
                onClick={() => { setReviewKey(e.key); setSavedExport(false); }}
                disabled={busy}
              >
                Review {index + 1} of {repairable.length} · {set ? names[set.exercise_id] ?? "Set logged" : "Set logged"} · set {set ? set.set_index + 1 : e.key}
              </button>
            );
          })}
          {review?.op.kind === "insert" && review.op.table === "sets" && (
            <div className="queue-repair-review">
              <div className="field-label">REVIEW THIS SET</div>
              <div>{describeOp(review.op, names)} · set {review.op.payload.set_index + 1}</div>
              <div>Logged total: {review.op.payload.load_kg} kg</div>
              {unit !== "kg" && <div>In your unit: {reviewTotal} total</div>}
              {review.op.payload.load_entry === "per_side" && (
                <div>Per side: {toDisplay(review.op.payload.load_kg / 2, unit)} {unit}/side</div>
              )}
              <div>Rejected row&apos;s entered fields: {review.op.payload.entered_load} {review.op.payload.entered_unit} ({review.op.payload.load_entry ?? "unknown"}). These may be stale.</div>
              <div>Reps: {review.op.payload.reps}</div>
              <div>Logged at: {review.op.payload.performed_at}</div>
              <div className="microcopy">
                The server keeps the exact {review.op.payload.load_kg} kg total.
                The inconsistent entered fields become unknown in the server row;
                the original remains in your queue export.
              </div>
              <label>
                <input
                  type="checkbox"
                  checked={savedExport}
                  onChange={(event) => setSavedExport(event.target.checked)}
                  disabled={!exportMatches || busy}
                />
                I saved the queue export and checked this total
              </label>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={repairReviewed}
                disabled={busy || !exportMatches || !savedExport}
              >
                Keep {reviewTotal} total and retry
              </button>
            </div>
          )}
          </>}
        </section>
      )}

      {held.length > 0 && (
        <section className="settings-group">
          <div className="field-label">HELD ({held.length})</div>
          {/* Count only. On a shared phone these are another person's sets,
              and listing them would show one account another's training
              (A-148). Export leaves their contents out for the same reason. */}
          <div className="microcopy">
            {/* This is the invariant, said out loud. A logged set takes its
                owner from whoever is signed in when it lands, and `sets` is
                append-only, so sending one under the wrong account is a
                mistake nothing can undo. Waiting is the only safe answer. */}
            Queued under a different account on this phone, or before it knew
            who was signed in. This phone will not send them as you: a logged
            set cannot be reassigned once it lands. Sign in as that account on
            this phone and they go up on their own.
          </div>
        </section>
      )}

      {waiting.length > 0 && (
        <section className="settings-group">
          <div className="field-label">WAITING ({waiting.length})</div>
          <QueueList entries={waiting} names={names} now={now} />
        </section>
      )}

      <section className="settings-group">
        <div className="field-label">ACTIONS</div>

        <button
          type="button"
          className="btn btn-ghost"
          onClick={retry}
          disabled={busy || retryable.length === 0}
        >
          {retryable.length === 0
            ? "Nothing to retry"
            : `Retry ${retryable.length} failed`}
        </button>
        <div className="microcopy">
          {dead.length > retryable.length
            ? "Some failed writes are excluded: rejected rows need repair, and linked removals or notes wait for their set to sync."
            : "Puts the failed writes back in the queue, in the order they were made."}
        </div>

        <button
          type="button"
          className="btn btn-ghost"
          onClick={runExport}
          disabled={busy || entries.length === 0}
        >
          {busy ? "Working…" : "Export queue as JSON"}
        </button>
        <div className="microcopy">
          Every queued write with its exercise, load, reps and time, in
          kilograms. Enough to type a session back in by hand if it comes to
          that.
        </div>
      </section>
    </Sheet>
  );
}

function QueueList({
  entries,
  names,
  now,
}: {
  entries: OutboxEntry[];
  names: Record<string, string>;
  now: number;
}) {
  const shown = entries.slice(0, LIST_CAP);
  return (
    <ul className="queue-list">
      {shown.map((e) => (
        <li key={e.key} className="queue-item">
          <span className="queue-item-name">
            {describeOp(e.op, names, e.state)}
          </span>
          <span className="queue-item-age">
            {e.created_at === null
              ? ""
              : formatAge(Math.max(0, now - Date.parse(e.created_at)))}
          </span>
          {e.last_error !== null && (
            <span className="queue-item-error">{e.last_error}</span>
          )}
        </li>
      ))}
      {entries.length > shown.length && (
        <li className="queue-item queue-item-more">
          {entries.length - shown.length} more, all of them in the export
        </li>
      )}
    </ul>
  );
}

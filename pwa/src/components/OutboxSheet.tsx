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
// It never edits or deletes a queued write. Corrections to a logged set are
// voids, and a queue is not a place to rewrite history — the two verbs offered
// here are "ask again" and "give me a copy".

import { useCallback, useEffect, useState } from "react";
import { Sheet } from "./Sheet";
import { outbox } from "../lib/sync";
import { useOutboxStatus } from "../hooks/useOutboxStatus";
import { getExercises } from "../lib/data";
import { buildQueueExport, downloadText, exportFilename } from "../lib/export";
import { reportError, toast } from "../lib/errors";
import { APP_VERSION } from "../lib/build";
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
): string {
  if (op.kind === "update") {
    if ("discarded_at" in op.patch) return "Session discarded";
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
    case "sets": {
      const name = exerciseNames[op.payload.exercise_id];
      return name === undefined ? "Set logged" : `Set · ${name}`;
    }
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
  const status = useOutboxStatus();
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

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
  const retryable = dead.filter((e) => e.retryable);
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
    outbox
      .inspect()
      .then((rows) => {
        const bundle = buildQueueExport(rows, names, APP_VERSION);
        downloadText(
          exportFilename("json", "unsynced"),
          "application/json",
          JSON.stringify(bundle, null, 2),
        );
        toast(`Exported ${bundle.items.length} queued writes`);
      })
      .catch((e: unknown) => reportError(e, "export the write queue"))
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
        </section>
      )}

      {held.length > 0 && (
        <section className="settings-group">
          <div className="field-label">HELD ({held.length})</div>
          <QueueList entries={held} names={names} now={now} />
          <div className="microcopy">
            {/* This is the invariant, said out loud. A logged set takes its
                owner from whoever is signed in when it lands, and `sets` is
                append-only, so sending one under the wrong account is a
                mistake nothing can undo. Waiting is the only safe answer. */}
            Queued while a different account was signed in here. This phone will
            not send them as you: a logged set cannot be reassigned once it
            lands. Sign in as that account on this phone and they go up on their
            own.
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
            ? `${dead.length - retryable.length} of the failed writes would be refused again unchanged, so retry leaves them alone rather than pretending.`
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
          <span className="queue-item-name">{describeOp(e.op, names)}</span>
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

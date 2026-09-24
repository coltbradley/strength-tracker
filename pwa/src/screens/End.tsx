// End session: sRPE 0-10, optional bodyweight (steppers + pad), optional
// note — the one allowed OS-keyboard field. The end write is an update,
// queued like everything else.

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Stepper } from "../components/Stepper";
import { SESSION_RPE_CHOICES } from "../lib/rpe";
import { NumberPad, type PadRequest } from "../components/NumberPad";
import {
  cacheGet,
  cacheSet,
  cacheDelete,
  cacheFamilies,
  cacheKeys,
  cacheKeysWithPrefix,
} from "../lib/db";
import {
  countServerSessionSets,
  invalidateForSessionClose,
  invalidateForSetChange,
  resolveSessionSetCount,
} from "../lib/data";
import { outbox } from "../lib/sync";
import { reportError, toast } from "../lib/errors";
import { useUnit } from "../hooks/useUnit";
import {
  fromDisplay,
  MAX_BODYWEIGHT_KG,
  stepKg,
  toDisplay,
} from "../lib/units";
import { formatStoredTwin } from "../lib/format";
import { readSkipsCache, sessionSkipRows, type SkipRecord } from "../lib/skips";
import type {
  ActiveSession,
  ResolvedPrescriptionRow,
  SetInsert,
} from "../lib/types";

// Mirror of the DB check: sessions.session_rpe between 0 and 10
// (supabase/migrations/20260825120001_schema.sql) — keep in sync.
const LAST_BW_KEY = "lastBodyweightKg";
/**
 * Raw cache key (see LAST_BW_KEY above — not a `cacheKeys` entry), keyed
 * by the PLANNED DAY rather than the session: Today reads this after
 * `activeSession` is already gone, and it never knew the session's id in
 * the first place, only the day's. Exported so Today.tsx imports this
 * exact function rather than keeping its own copy of the template
 * string, which is how the two would drift.
 */
export const doneSummaryKey = (plannedWorkoutId: string): string =>
  `doneSummary:${plannedWorkoutId}`;

/** What Today's DONE card shows for a day it has no other way to
 *  summarise once the session that finished it is gone. Deliberately NOT
 *  working volume/tonnage — that is a derived metric owned by
 *  `v_weekly_volume`'s filtering rules, and re-deriving it here would be a
 *  second, driftable definition of the same number. */
export interface DoneSummary {
  setCount: number;
  durationSeconds: number;
}
const NOTE_CHIPS = [
  "Felt strong",
  "Sleep was short",
  "Left shoulder",
  "Bar speed good",
];
/** the summary's elapsed figure is minute-resolution, so a minute is as
 *  often as it can change */
const DURATION_TICK_MS = 60_000;

/** "47 MIN" / "1H 12M" — session length. formatClock would render 72 minutes
 *  as "72:00", which reads as seventy-two seconds at a glance. */
export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} MIN`;
  return `${Math.floor(m / 60)}H ${String(m % 60).padStart(2, "0")}M`;
}

/** Staged End-screen input, kept across a "Back to session" round trip. */
interface EndDraft {
  rpe: number | null;
  bwOpen: boolean;
  bwKg: number;
  note: string;
  noteOpen: boolean;
}

export function End() {
  const navigate = useNavigate();
  const unit = useUnit();
  const [active, setActive] = useState<ActiveSession | null | undefined>(
    undefined,
  );
  const [rpe, setRpe] = useState<number | null>(null);
  const [bwOpen, setBwOpen] = useState(false);
  const [bwKg, setBwKg] = useState(80);
  const [bwPad, setBwPad] = useState(false);
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [setCount, setSetCount] = useState(0);
  /** false until the count is known to be right; gates Discard-as-primary */
  const [countKnown, setCountKnown] = useState(false);
  const [discardAttemptAt, setDiscardAttemptAt] = useState<string | null>(null);
  const [discardNotice, setDiscardNotice] = useState<string | null>(null);
  const [exercisesDone, setExercisesDone] = useState(0);
  const [exercisesTotal, setExercisesTotal] = useState(0);
  // ticks so a summary left open while writing a note stays honest
  const [now, setNow] = useState(() => Date.now());
  // the draft is persisted on unmount, but not once the session is closed
  const closedRef = useRef(false);
  /** re-entrancy guard for end(); a ref, because state is batched */
  const endingRef = useRef(false);
  const discardResolvingRef = useRef<string | null>(null);
  const discardResolvedRef = useRef(false);
  const resolveDiscardRef = useRef<((attemptAt: string) => Promise<void>) | null>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = active?.id ?? null;
  const draftRef = useRef<EndDraft | null>(null);
  draftRef.current = { rpe, bwOpen, bwKg, note, noteOpen };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // EVERY read here is guarded. `active === undefined` renders nothing
      // but a spinner, so an unguarded throw used to leave the finish screen
      // permanently blank with an open session and no way out of it.
      let a: ActiveSession | null | undefined;
      try {
        a = await cacheGet<ActiveSession>(cacheKeys.activeSession);
      } catch (e) {
        reportError(e, "read active session");
        a = null;
      }
      if (cancelled) return;
      setActive(a ?? null);
      if (!a) return;

      try {
        const draft = await cacheGet<EndDraft>(cacheKeys.sessionEndDraft(a.id));
        if (!cancelled && draft) {
          setRpe(draft.rpe);
          setBwOpen(draft.bwOpen);
          setBwKg(draft.bwKg);
          setNote(draft.note);
          setNoteOpen(draft.noteOpen);
        }
      } catch (e) {
        reportError(e, "restore end-of-session draft");
      }

      let localCount = 0;
      try {
        const cached =
          (await cacheGet<SetInsert[]>(cacheKeys.sessionSets(a.id))) ?? [];
        const pending = await outbox.pendingSets(a.id);
        // pending (and re-cached server rows) can still contain sets whose
        // void hasn't flushed — the counts must match what Session shows
        const voided = new Set(
          (await cacheGet<string[]>(cacheKeys.sessionVoids(a.id))) ?? [],
        );
        const all = new Map(
          [...cached, ...pending]
            .filter((s) => !voided.has(s.id))
            .map((s) => [s.id, s]),
        );
        localCount = all.size;
        const exercisesLogged = new Set(
          [...all.values()].map((s) => s.exercise_id),
        );
        if (!cancelled) setExercisesDone(exercisesLogged.size);
        const rxCached =
          (await cacheGet<ResolvedPrescriptionRow[]>(
            cacheKeys.sessionRx(a.id),
          )) ?? [];
        const extras =
          (await cacheGet<Array<{ exercise_id: string }>>(
            cacheKeys.sessionExtras(a.id),
          )) ?? [];
        const skipMap = readSkipsCache(
          (await cacheGet<string[] | Record<string, SkipRecord>>(
            cacheKeys.sessionSkips(a.id),
          )) ?? {},
        );
        const skipped = new Set(Object.keys(skipMap));
        // skip keys are the exercise's FIRST bracket id (grouped entries),
        // so resolve skips to exercise ids before counting
        const skippedExercises = new Set(
          rxCached.filter((r) => skipped.has(r.id)).map((r) => r.exercise_id),
        );
        const planned = new Set<string>();
        for (const r of rxCached)
          if (!skippedExercises.has(r.exercise_id)) planned.add(r.exercise_id);
        for (const e of extras)
          if (!skipped.has(`extra:${e.exercise_id}`))
            planned.add(e.exercise_id);
        for (const id of exercisesLogged) planned.add(id);
        if (!cancelled) setExercisesTotal(planned.size);
      } catch (e) {
        reportError(e, "read session summary");
      }

      // A local zero is NOT proof of an empty session — an adopted orphan
      // whose server fetch failed looks exactly like one. Only the server
      // can confirm emptiness, and only then may Discard lead.
      let server: number | null = null;
      if (localCount === 0) {
        try {
          server = await countServerSessionSets(a.id);
        } catch (e) {
          reportError(e, "confirm session is empty");
        }
      }
      if (cancelled) return;
      const verdict = resolveSessionSetCount(localCount, server);
      setSetCount(verdict.count);
      setCountKnown(verdict.authoritative);

      try {
        const lastBw = await cacheGet<number>(LAST_BW_KEY);
        if (!cancelled && lastBw) setBwKg(lastBw);
      } catch (e) {
        reportError(e, "read last bodyweight");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (active === null) navigate("/", { replace: true });
  }, [active, navigate]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), DURATION_TICK_MS);
    return () => clearInterval(t);
  }, []);

  // A discard queued while offline may settle later from the global outbox
  // online/foreground retry. Keep the End screen authoritative until that
  // exact operation is accepted or refused.
  useEffect(() => {
    if (discardAttemptAt === null) return;
    const check = () => {
      const resolve = resolveDiscardRef.current;
      if (resolve) void resolve(discardAttemptAt);
    };
    const unsubscribe = outbox.subscribe(check);
    check();
    return unsubscribe;
  }, [discardAttemptAt]);

  // sRPE / bodyweight / note survive a "Back to session" round trip
  useEffect(
    () => () => {
      const id = activeIdRef.current;
      const d = draftRef.current;
      if (closedRef.current || id === null || d === null) return;
      // nothing staged, nothing to keep
      if (d.rpe === null && !d.bwOpen && !d.noteOpen && d.note === "") return;
      void cacheSet(cacheKeys.sessionEndDraft(id), d).catch((e: unknown) =>
        reportError(e, "save end-of-session draft"),
      );
    },
    [],
  );

  if (active === undefined) return <div className="screen muted">Loading…</div>;
  if (active === null) return null;

  /** Mark this session's planned day done in the CACHED week state.
   *  Dropping the cache instead would be a no-op offline — the refetch that
   *  would rebuild it is exactly what cannot run — and the day would keep
   *  reading as unfinished until the phone found signal again. */
  const markPlannedDayDone = async (plannedWorkoutId: string | null) => {
    if (!plannedWorkoutId) return;
    const keys = await cacheKeysWithPrefix(cacheFamilies.sessionClosed);
    for (const key of keys) {
      const ids = (await cacheGet<string[]>(key)) ?? [];
      if (!ids.includes(plannedWorkoutId))
        await cacheSet(key, [...ids, plannedWorkoutId]);
    }
  };

  /** One `session_skips` row per entry STILL skipped when Finish is tapped
   *  (spec: "session_skips"). An un-skip earlier in the session never
   *  reaches the network — only this snapshot does — and a session that is
   *  never finished loses its skips (accepted, see docs/decisions.md). A
   *  legacy (pre-reason) cache entry carries no exercise; resolve it from
   *  `rx`/`extras` the same way the summary above already does, or drop it
   *  rather than violate the `exercises` FK with an empty string. */
  const writeSessionSkips = async (sessionId: string) => {
    const skipMap = readSkipsCache(
      (await cacheGet<string[] | Record<string, SkipRecord>>(
        cacheKeys.sessionSkips(sessionId),
      )) ?? {},
    );
    const raw = Object.values(skipMap);
    if (raw.length === 0) return;
    const rxCached =
      (await cacheGet<ResolvedPrescriptionRow[]>(
        cacheKeys.sessionRx(sessionId),
      )) ?? [];
    const extras =
      (await cacheGet<Array<{ exercise_id: string }>>(
        cacheKeys.sessionExtras(sessionId),
      )) ?? [];
    const resolved = raw
      .map((skip) => {
        if (skip.exerciseId !== "") return skip;
        const rx = rxCached.find((r) => r.id === skip.entryKey);
        // A legacy skip's entryKey IS the prescription id (the same
        // assumption the summary block above makes matching skipped
        // entries against rxCached by `r.id`), so resolving the exercise
        // from rx also resolves the prescription it was recorded against.
        if (rx)
          return { ...skip, exerciseId: rx.exercise_id, prescriptionId: rx.id };
        const extraId = skip.entryKey.startsWith("extra:")
          ? skip.entryKey.slice("extra:".length)
          : null;
        const extra = extraId
          ? extras.find((e) => e.exercise_id === extraId)
          : undefined;
        return extra ? { ...skip, exerciseId: extra.exercise_id } : null;
      })
      .filter((skip): skip is SkipRecord => skip !== null);
    if (resolved.length === 0) return;
    const rows = sessionSkipRows(sessionId, resolved);
    await outbox.enqueueBatch(
      rows.map((payload) => ({
        kind: "insert" as const,
        table: "session_skips" as const,
        payload,
      })),
    );
  };

  const end = async () => {
    // A ref, not state: React batches a state update, so a genuine double-tap
    // (or a tap that lands twice through a slow frame) reads the old value and
    // runs the whole close twice — two queued updates, markPlannedDayDone
    // twice, two navigations.
    if (endingRef.current) return;
    endingRef.current = true;
    try {
      const endedAtMs = Math.max(
        Date.now(),
        Date.parse(active.started_at) || 0,
      );
      await outbox.enqueue({
        kind: "update",
        table: "sessions",
        id: active.id,
        patch: {
          // `sessions` carries `check (ended_at >= started_at)`, and this is
          // the wall clock, which is not guaranteed to agree with the one that
          // stamped started_at — a phone whose time drifts back, or a session
          // adopted from another device. A violation is a 23514, which the
          // outbox classifies as dead: the close would sit in the queue
          // failing forever, with the session still open. syncOpenSessions
          // already clamps for exactly this reason; so does this now.
          ended_at: new Date(endedAtMs).toISOString(),
          session_rpe: rpe,
          bodyweight_kg: bwOpen ? Math.round(bwKg * 10) / 10 : null,
          notes: note.trim() === "" ? null : note.trim(),
        },
      });
      await writeSessionSkips(active.id);
      // Today remounts fresh the instant we navigate and reads DONE
      // online-first (fetchWithCache tries the server before the cache).
      // enqueue() above only FIRES a flush, it doesn't wait for one — so
      // without this, Today's read could win the race against our own
      // write and come back "not done" for a session that just ended.
      // Same fix History.tsx's voidPastSet/discardSession already use:
      // wait for the queue to be walked so this is on the server before
      // anything asks the server what is live. Offline it's a no-op
      // (doFlush leaves everything queued), which is exactly why
      // markPlannedDayDone below still runs regardless. Bounded: on gym
      // wifi that hangs, a flush can take the full request timeout, and
      // Finish must never sit waiting on the network. After 1.5 s Today
      // falls back to the local done state written below.
      await Promise.race([
        outbox.flush(),
        new Promise<void>((resolve) => window.setTimeout(resolve, 1500)),
      ]);
      closedRef.current = true;
      if (bwOpen) await cacheSet(LAST_BW_KEY, bwKg);
      await cacheDelete(cacheKeys.activeSession);
      await clearSessionCaches(active.id);
      // symmetric with discard(): every derived read now returns something
      // different, and the planned day is done
      await invalidateForSetChange();
      await markPlannedDayDone(active.planned_workout_id);
      // What Today's DONE card shows for this day. Keyed by the planned
      // day, not the session, because Today reads it after
      // `activeSession` above is already gone.
      if (active.planned_workout_id) {
        await cacheSet(doneSummaryKey(active.planned_workout_id), {
          setCount,
          durationSeconds: Math.max(
            0,
            (endedAtMs - Date.parse(active.started_at)) / 1000,
          ),
        });
      }
      toast(
        `Session done — ${setCount} set${setCount === 1 ? "" : "s"} logged${
          rpe !== null ? `, sRPE ${rpe}` : ""
        }`,
      );
      navigate("/", { replace: true });
    } catch (e) {
      // let them try again: the failure may be transient, and the session is
      // still open
      endingRef.current = false;
      reportError(e, "end session");
    }
  };

  /** Session-scoped kv entries have no reader once the session is closed —
   *  drop them so the cache doesn't grow forever. */
  const clearSessionCaches = async (id: string) => {
    for (const key of [
      cacheKeys.sessionRx(id),
      cacheKeys.sessionExtras(id),
      cacheKeys.sessionSets(id),
      cacheKeys.sessionVoids(id),
      cacheKeys.sessionSkips(id),
      cacheKeys.sessionRest(id),
      cacheKeys.sessionSetNotes(id),
      cacheKeys.sessionEndDraft(id),
    ]) {
      await cacheDelete(key).catch(() => undefined);
    }
  };

  /** Close locally only after the discard update has left the outbox. */
  const finishDiscard = async () => {
    if (discardResolvedRef.current) return;
    discardResolvedRef.current = true;
    closedRef.current = true;
    setDiscardAttemptAt(null);
    setDiscardNotice(null);
    await cacheDelete(cacheKeys.activeSession);
    await clearSessionCaches(active.id);
    // history caches and week DONE state all reference this session
    await invalidateForSessionClose();
    toast("Session discarded");
    navigate("/", { replace: true });
  };

  const resolveDiscard = async (attemptAt: string) => {
    if (discardResolvingRef.current === attemptAt || discardResolvedRef.current)
      return;
    discardResolvingRef.current = attemptAt;
    try {
      const matching = (await outbox.inspect()).find(
        (entry) =>
          entry.op.kind === "update" &&
          entry.op.table === "sessions" &&
          entry.op.id === active.id &&
          "discarded_at" in entry.op.patch &&
          entry.op.patch.discarded_at === attemptAt,
      );
      if (!matching) {
        await finishDiscard();
        return;
      }
      if (matching.state === "dead") {
        setDiscardAttemptAt(null);
        if (/cannot discard a session that contains sets/i.test(matching.last_error ?? "")) {
          const message =
            "A set from another device reached this session first. The workout is staying in your history, so end the session instead.";
          setDiscardNotice(message);
          toast(message, "error");
          reportError(new Error(matching.last_error ?? message), "discard session", {
            toast: false,
          });
        } else {
          const message =
            "The server refused this discard. The session is still open; check Sync status for details.";
          setDiscardNotice(message);
          reportError(new Error(matching.last_error ?? message), "discard session");
        }
        return;
      }
      setDiscardNotice(
        "Discard is waiting to sync. The session stays open until the server confirms it.",
      );
    } catch (e) {
      reportError(e, "check discard status");
    } finally {
      if (discardResolvingRef.current === attemptAt)
        discardResolvingRef.current = null;
    }
  };
  resolveDiscardRef.current = resolveDiscard;

  /** Soft delete an accidental, server-confirmed empty session. */
  const discard = async () => {
    if (discardAttemptAt !== null) return;
    const attemptedAt = new Date().toISOString();
    try {
      await outbox.enqueue({
        kind: "update",
        table: "sessions",
        id: active.id,
        patch: { discarded_at: attemptedAt },
      });
      setDiscardNotice(null);
      setDiscardAttemptAt(attemptedAt);
      await outbox.flush();
      await resolveDiscard(attemptedAt);
    } catch (e) {
      setDiscardAttemptAt(null);
      reportError(e, "discard session");
    }
  };

  const addChip = (chip: string) => {
    setNote((n) => (n.trim() === "" ? chip : `${n.trimEnd()}. ${chip}`));
  };

  // ONLY a server-confirmed zero may lead with Discard
  const confirmedEmpty = countKnown && setCount === 0;

  /** Wall-clock length of the session so far — `started_at` to now, which is
   *  what `ended_at` is about to be. Suppressed when the arithmetic can't be
   *  trusted (a clock change, a corrupt cache) rather than shown wrong; the
   *  overnight sweep bounds a real session to one local day. */
  const startedMs = Date.parse(active.started_at);
  const elapsedSeconds = Number.isFinite(startedMs)
    ? (now - startedMs) / 1000
    : Number.NaN;
  const duration =
    Number.isFinite(elapsedSeconds) &&
    elapsedSeconds >= 0 &&
    elapsedSeconds < 24 * 3600
      ? formatDuration(elapsedSeconds)
      : null;

  const bwSub = formatStoredTwin(bwKg, unit);

  const bwPadReq: PadRequest | null = bwPad
    ? {
        label: `BODYWEIGHT · ${unit.toUpperCase()}`,
        action: "SET WEIGHT",
        initial: String(toDisplay(bwKg, unit)),
        allowDecimal: true,
        onCommit: (v) => {
          const kg = Math.min(MAX_BODYWEIGHT_KG, Math.max(1, fromDisplay(v, unit)));
          setBwKg(Math.round(kg * 10) / 10);
          setBwPad(false);
        },
        onCancel: () => setBwPad(false),
      }
    : null;

  return (
    <div className="screen">
      <h1 className="screen-title">End session</h1>
      {/* the exercise breakdown is device-local; when the set count came from
          the server instead (cold cache) there is no breakdown to show, and
          "0 OF 7 EXERCISES" next to "3 SETS LOGGED" would just be wrong */}
      <p className="end-summary">
        {duration !== null && `${duration} · `}
        {countKnown
          ? `${setCount} ${setCount === 1 ? "SET" : "SETS"} LOGGED`
          : "SET COUNT UNKNOWN OFFLINE"}
        {exercisesDone > 0 &&
          ` · ${exercisesDone} OF ${Math.max(
            exercisesTotal,
            exercisesDone,
          )} EXERCISES`}
      </p>

      <section className="rule-section">
        <div className="section-head">
          <span className="field-label">SESSION RPE</span>
        </div>
        <div className="rpe-grid">
          {SESSION_RPE_CHOICES.map((n) => (
            <button
              key={n}
              type="button"
              className={`seg-btn rpe-btn ${rpe === n ? "seg-on" : ""}`}
              onClick={() => setRpe(rpe === n ? null : n)}
            >
              {n}
            </button>
          ))}
        </div>
      </section>

      <section className="rule-section">
        <div className="section-head">
          <span className="field-label">BODYWEIGHT · {unit.toUpperCase()}</span>
          {bwOpen && <span className="section-meta">{bwSub}</span>}
        </div>
        {bwOpen ? (
          <Stepper
            label="bodyweight"
            inline
            display={String(toDisplay(bwKg, unit))}
            onTapValue={() => setBwPad(true)}
            value={bwKg}
            min={1}
            max={MAX_BODYWEIGHT_KG}
            onChange={setBwKg}
            steps={[
              { label: "−", delta: -stepKg(unit, true) },
              { label: "+", delta: stepKg(unit, true) },
            ]}
          />
        ) : (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setBwOpen(true)}
          >
            Add bodyweight
          </button>
        )}
      </section>

      <section className="rule-section">
        <div className="section-head">
          <span className="field-label">NOTE · OPTIONAL</span>
        </div>
        {noteOpen ? (
          <>
            <textarea
              className="input note-input"
              placeholder="How did it go?"
              rows={3}
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="chip-row">
              {NOTE_CHIPS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="chip"
                  onClick={() => addChip(c)}
                >
                  {c}
                </button>
              ))}
            </div>
          </>
        ) : (
          // collapsed like Bodyweight above — the primary action stays in view
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setNoteOpen(true)}
          >
            Add note
          </button>
        )}
      </section>

      {confirmedEmpty ? (
        <>
          {/* an accidental start must not mark the planned day DONE — with
              nothing logged AND the server agreeing, discard is the honest
              default. An UNCONFIRMED zero never gets here. */}
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() => void discard()}
            disabled={discardAttemptAt !== null}
          >
            {discardAttemptAt === null ? "Discard empty session" : "Discard waiting for sync…"}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-block"
            onClick={() => void end()}
            disabled={discardAttemptAt !== null}
          >
            End anyway (counts as done)
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn btn-primary btn-block"
          onClick={() => void end()}
        >
          End session
        </button>
      )}
      {discardNotice !== null && (
        <div className="microcopy" role="status">
          {discardNotice}
          {discardAttemptAt !== null && (
            <button
              type="button"
              className="btn btn-secondary btn-block"
              onClick={() => {
                void outbox.flush().then(() => resolveDiscard(discardAttemptAt));
              }}
            >
              Check discard sync
            </button>
          )}
        </div>
      )}
      {!countKnown ? (
        <div className="microcopy">
          Couldn’t reach the server to check this session’s sets, so nothing
          here is offered as empty. Ending is safe. Discard is available only
          when the server confirms there are no sets.
        </div>
      ) : setCount > 0 ? (
        <div className="microcopy">
          Sessions with logged sets stay in your training history. End the
          session to keep this workout recorded.
        </div>
      ) : null}
      <button
        type="button"
        className="btn btn-ghost btn-block"
        onClick={() => navigate("/session")}
        disabled={discardAttemptAt !== null}
      >
        Back to session
      </button>


      {bwPadReq && <NumberPad req={bwPadReq} />}
    </div>
  );
}

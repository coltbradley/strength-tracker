// End session: sRPE 0-10, optional bodyweight (steppers + pad), optional
// note — the one allowed OS-keyboard field. The end write is an update,
// queued like everything else.

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Stepper } from "../components/Stepper";
import { NumberPad, type PadRequest } from "../components/NumberPad";
import {
  cacheGet,
  cacheSet,
  cacheDelete,
  cacheDeleteByPrefix,
  cacheKeys,
  cacheKeysWithPrefix,
} from "../lib/db";
import { countServerSessionSets, resolveSessionSetCount } from "../lib/data";
import { outbox } from "../lib/sync";
import { reportError, toast } from "../lib/errors";
import { useUnit } from "../hooks/useUnit";
import { useArmed } from "../hooks/useArmed";
import { fromDisplay, kgToLb, stepKg, toDisplay } from "../lib/units";
import type {
  ActiveSession,
  ResolvedPrescriptionRow,
  SetInsert,
} from "../lib/types";

// Mirror of the DB check: sessions.session_rpe between 0 and 10
// (supabase/migrations/20260825120001_schema.sql) — keep in sync.
const RPE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const LAST_BW_KEY = "lastBodyweightKg";
const NOTE_CHIPS = [
  "Felt strong",
  "Sleep was short",
  "Left shoulder",
  "Bar speed good",
];
const MAX_BW_KG = 400;

/** Everything derived from this session's sets or its closed/open state.
 *  Ending and discarding invalidate the SAME families — an asymmetry here
 *  is why a finished session used to leave the planned day looking unfinished
 *  and the next session prefilling from pre-session actuals. */
const DERIVED_PREFIXES = [
  "recent:",
  "e1rm:",
  "volume:",
  "goal:",
  "sessionMeta:",
  "setNotes:",
  "lastActuals:",
];

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
  const [liftsDone, setLiftsDone] = useState(0);
  const [liftsTotal, setLiftsTotal] = useState(0);
  const [armed, setArmed] = useArmed();
  const discardArmed = armed === "discard";
  // the draft is persisted on unmount, but not once the session is closed
  const closedRef = useRef(false);
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
        if (!cancelled) setLiftsDone(exercisesLogged.size);
        const rxCached =
          (await cacheGet<ResolvedPrescriptionRow[]>(
            cacheKeys.sessionRx(a.id),
          )) ?? [];
        const extras =
          (await cacheGet<Array<{ exercise_id: string }>>(
            cacheKeys.sessionExtras(a.id),
          )) ?? [];
        const skipped = new Set(
          (await cacheGet<string[]>(cacheKeys.sessionSkips(a.id))) ?? [],
        );
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
        if (!cancelled) setLiftsTotal(planned.size);
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
    const keys = await cacheKeysWithPrefix(["doneWorkouts:"]);
    for (const key of keys) {
      const ids = (await cacheGet<string[]>(key)) ?? [];
      if (!ids.includes(plannedWorkoutId))
        await cacheSet(key, [...ids, plannedWorkoutId]);
    }
  };

  const end = async () => {
    try {
      await outbox.enqueue({
        kind: "update",
        table: "sessions",
        id: active.id,
        patch: {
          ended_at: new Date().toISOString(),
          session_rpe: rpe,
          bodyweight_kg: bwOpen ? Math.round(bwKg * 10) / 10 : null,
          notes: note.trim() === "" ? null : note.trim(),
        },
      });
      closedRef.current = true;
      if (bwOpen) await cacheSet(LAST_BW_KEY, bwKg);
      await cacheDelete(cacheKeys.activeSession);
      await clearSessionCaches(active.id);
      // symmetric with discard(): every derived read now returns something
      // different, and the planned day is done
      await cacheDeleteByPrefix(DERIVED_PREFIXES);
      await markPlannedDayDone(active.planned_workout_id);
      toast(
        `Session done — ${setCount} set${setCount === 1 ? "" : "s"} logged${
          rpe !== null ? `, sRPE ${rpe}` : ""
        }`,
      );
      navigate("/", { replace: true });
    } catch (e) {
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

  /** Soft delete: the session and its sets leave every chart and history
   *  list. Nothing is destroyed — recoverable in the database if ever needed. */
  const discard = async () => {
    try {
      await outbox.enqueue({
        kind: "update",
        table: "sessions",
        id: active.id,
        patch: { discarded_at: new Date().toISOString() },
      });
      closedRef.current = true;
      await cacheDelete(cacheKeys.activeSession);
      await clearSessionCaches(active.id);
      // history caches and week DONE state all reference this session
      await cacheDeleteByPrefix([...DERIVED_PREFIXES, "doneWorkouts:"]);
      toast("Session discarded");
      navigate("/", { replace: true });
    } catch (e) {
      reportError(e, "discard session");
    }
  };

  const addChip = (chip: string) => {
    setNote((n) => (n.trim() === "" ? chip : `${n.trimEnd()}. ${chip}`));
  };

  // ONLY a server-confirmed zero may lead with Discard
  const confirmedEmpty = countKnown && setCount === 0;

  const bwSub =
    unit === "lb"
      ? `${Math.round(bwKg * 10) / 10} kg stored`
      : `${Math.round(kgToLb(bwKg) * 10) / 10} lb`;

  const bwPadReq: PadRequest | null = bwPad
    ? {
        label: `BODYWEIGHT · ${unit.toUpperCase()}`,
        action: "SET WEIGHT",
        initial: String(toDisplay(bwKg, unit)),
        allowDecimal: true,
        onCommit: (v) => {
          const kg = Math.min(MAX_BW_KG, Math.max(1, fromDisplay(v, unit)));
          setBwKg(Math.round(kg * 10) / 10);
          setBwPad(false);
        },
        onCancel: () => setBwPad(false),
      }
    : null;

  return (
    <div className="screen">
      <h2 className="screen-title">End session</h2>
      {/* the lifts breakdown is device-local; when the set count came from
          the server instead (cold cache) there is no breakdown to show, and
          "0 OF 7 LIFTS" next to "3 SETS LOGGED" would just be wrong */}
      <p className="end-summary">
        {countKnown
          ? `${setCount} ${setCount === 1 ? "SET" : "SETS"} LOGGED`
          : "SET COUNT UNKNOWN OFFLINE"}
        {liftsDone > 0 &&
          ` · ${liftsDone} OF ${Math.max(liftsTotal, liftsDone)} LIFTS`}
      </p>

      <section className="rule-section">
        <div className="section-head">
          <span className="field-label">SESSION RPE</span>
        </div>
        <div className="rpe-grid">
          {RPE.map((n) => (
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
            max={MAX_BW_KG}
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
          >
            Discard empty session
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-block"
            onClick={() => void end()}
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
      {!countKnown && (
        <div className="microcopy">
          Couldn’t reach the server to check this session’s sets, so nothing
          here is offered as empty. Ending is safe — discard stays below.
        </div>
      )}
      <button
        type="button"
        className="btn btn-ghost btn-block"
        onClick={() => navigate("/session")}
      >
        Back to session
      </button>

      {/* the confirmed-empty variant already leads with discard — no duplicate */}
      {!confirmedEmpty && (
        <section className="rule-section">
          <button
            type="button"
            className={`btn btn-block ${discardArmed ? "btn-danger" : "btn-ghost"}`}
            onClick={() =>
              discardArmed ? void discard() : setArmed("discard")
            }
          >
            {discardArmed ? "Discard session?" : "Discard session"}
          </button>
          {discardArmed && (
            <div className="microcopy">
              {countKnown
                ? `Removes this session and its ${setCount} ${
                    setCount === 1 ? "set" : "sets"
                  } from history and charts.`
                : "Removes this session and everything logged in it from history and charts. This device could not confirm how much that is."}
            </div>
          )}
        </section>
      )}

      {bwPadReq && <NumberPad req={bwPadReq} />}
    </div>
  );
}

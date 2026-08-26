// End session: sRPE 0-10, optional bodyweight (steppers + pad), optional
// note — the one allowed OS-keyboard field. The end write is an update,
// queued like everything else.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Stepper } from "../components/Stepper";
import { NumberPad, type PadRequest } from "../components/NumberPad";
import {
  cacheGet,
  cacheSet,
  cacheDelete,
  cacheDeleteByPrefix,
  cacheKeys,
} from "../lib/db";
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
  const [setCount, setSetCount] = useState(0);
  const [liftsDone, setLiftsDone] = useState(0);
  const [liftsTotal, setLiftsTotal] = useState(0);
  const [armed, setArmed] = useArmed();
  const discardArmed = armed === "discard";

  useEffect(() => {
    void (async () => {
      const a = await cacheGet<ActiveSession>(cacheKeys.activeSession);
      setActive(a ?? null);
      if (a) {
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
        setSetCount(all.size);
        const exercisesLogged = new Set(
          [...all.values()].map((s) => s.exercise_id),
        );
        setLiftsDone(exercisesLogged.size);
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
        const planned = new Set<string>();
        for (const r of rxCached)
          if (!skipped.has(r.id)) planned.add(r.exercise_id);
        for (const e of extras)
          if (!skipped.has(`extra:${e.exercise_id}`))
            planned.add(e.exercise_id);
        for (const id of exercisesLogged) planned.add(id);
        setLiftsTotal(planned.size);
      }
      const lastBw = await cacheGet<number>(LAST_BW_KEY);
      if (lastBw) setBwKg(lastBw);
    })();
  }, []);

  useEffect(() => {
    if (active === null) navigate("/", { replace: true });
  }, [active, navigate]);

  if (!active) return null;

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
      if (bwOpen) await cacheSet(LAST_BW_KEY, bwKg);
      await cacheDelete(cacheKeys.activeSession);
      await clearSessionCaches(active.id);
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
      await cacheDelete(cacheKeys.activeSession);
      await clearSessionCaches(active.id);
      // history caches and week DONE state all reference this session
      await cacheDeleteByPrefix([
        "recent:",
        "e1rm:",
        "volume:",
        "goal:",
        "sessionMeta:",
        "lastActuals:",
        "doneWorkouts:",
      ]);
      toast("Session discarded");
      navigate("/", { replace: true });
    } catch (e) {
      reportError(e, "discard session");
    }
  };

  const addChip = (chip: string) => {
    setNote((n) => (n.trim() === "" ? chip : `${n.trimEnd()}. ${chip}`));
  };

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
      <p className="end-summary">
        {setCount} {setCount === 1 ? "SET" : "SETS"} LOGGED · {liftsDone} OF{" "}
        {Math.max(liftsTotal, liftsDone)} LIFTS
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
        <textarea
          className="input note-input"
          placeholder="How did it go?"
          rows={3}
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
      </section>

      {setCount === 0 ? (
        <>
          {/* an accidental start must not mark the planned day DONE — with
              nothing logged, discard is the honest default */}
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
      <button
        type="button"
        className="btn btn-ghost btn-block"
        onClick={() => navigate("/session")}
      >
        Back to session
      </button>

      <section className="rule-section">
        <button
          type="button"
          className={`btn btn-block ${discardArmed ? "btn-danger" : "btn-ghost"}`}
          onClick={() => (discardArmed ? void discard() : setArmed("discard"))}
        >
          {discardArmed ? "Discard session?" : "Discard session"}
        </button>
        {discardArmed && (
          <div className="microcopy">
            Removes this session and its {setCount}{" "}
            {setCount === 1 ? "set" : "sets"} from history and charts.
          </div>
        )}
      </section>

      {bwPadReq && <NumberPad req={bwPadReq} />}
    </div>
  );
}

// End session: sRPE 0-10, optional bodyweight (steppers + pad), optional
// note — the one allowed OS-keyboard field. The end write is an update,
// queued like everything else.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Stepper } from "../components/Stepper";
import { NumberPad, type PadRequest } from "../components/NumberPad";
import { cacheGet, cacheSet, cacheDelete, cacheKeys } from "../lib/db";
import { outbox } from "../lib/sync";
import { reportError, toast } from "../lib/errors";
import { useUnit } from "../hooks/useUnit";
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

  useEffect(() => {
    void (async () => {
      const a = await cacheGet<ActiveSession>(cacheKeys.activeSession);
      setActive(a ?? null);
      if (a) {
        const cached =
          (await cacheGet<SetInsert[]>(cacheKeys.sessionSets(a.id))) ?? [];
        const pending = await outbox.pendingSets(a.id);
        const all = new Map([...cached, ...pending].map((s) => [s.id, s]));
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
        const planned = new Set(rxCached.map((r) => r.exercise_id));
        for (const e of extras) planned.add(e.exercise_id);
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

      <button
        type="button"
        className="btn btn-primary btn-block"
        onClick={() => void end()}
      >
        End session
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-block"
        onClick={() => navigate("/session")}
      >
        Back to session
      </button>

      {bwPadReq && <NumberPad req={bwPadReq} />}
    </div>
  );
}

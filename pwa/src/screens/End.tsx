// End session: sRPE 0-10, optional bodyweight, optional note (the one place
// a keyboard is fine). The end write is an update, queued like everything else.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Stepper } from "../components/Stepper";
import { cacheGet, cacheSet, cacheDelete, cacheKeys } from "../lib/db";
import { outbox } from "../lib/sync";
import { reportError, toast } from "../lib/errors";
import { useUnit } from "../hooks/useUnit";
import { toDisplay, stepKg } from "../lib/units";
import type { ActiveSession, SetInsert } from "../lib/types";

const RPE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const LAST_BW_KEY = "lastBodyweightKg";

export function End() {
  const navigate = useNavigate();
  const unit = useUnit();
  const [active, setActive] = useState<ActiveSession | null | undefined>(
    undefined,
  );
  const [rpe, setRpe] = useState<number | null>(null);
  const [bwOpen, setBwOpen] = useState(false);
  const [bwKg, setBwKg] = useState(80);
  const [note, setNote] = useState("");
  const [setCount, setSetCount] = useState(0);

  useEffect(() => {
    void (async () => {
      const a = await cacheGet<ActiveSession>(cacheKeys.activeSession);
      setActive(a ?? null);
      if (a) {
        const cached =
          (await cacheGet<SetInsert[]>(cacheKeys.sessionSets(a.id))) ?? [];
        const pending = await outbox.pendingSets(a.id);
        const ids = new Set([...cached, ...pending].map((s) => s.id));
        setSetCount(ids.size);
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

  return (
    <div className="screen">
      <h2 className="screen-title">End session</h2>
      <p className="muted">{setCount} sets logged</p>

      <div className="field-label">Session RPE</div>
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

      {bwOpen ? (
        <Stepper
          label={`bodyweight (${unit})`}
          value={bwKg}
          display={String(toDisplay(bwKg, unit))}
          step={stepKg(unit, true)}
          onChange={setBwKg}
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

      <textarea
        className="input note-input"
        placeholder="Notes (optional)"
        rows={3}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

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
    </div>
  );
}

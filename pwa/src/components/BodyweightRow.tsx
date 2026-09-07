// Bodyweight, on the days there is no session.
//
// `sessions.bodyweight_kg` has existed since the first schema and was written
// zero times in a month of real use, because the End screen is only reached by
// tapping Finish. Meanwhile the number matters most on the days nobody
// trained. So the capture moves to where someone already looks: one line on
// Today, showing what they last weighed and taking today's figure in a tap.
//
// It reads `v_bodyweight` through `getBodyweight`, never one table — a row
// that showed only the standalone log would go blank for a lifter who has
// only ever weighed in before training, and be confidently wrong about it.

import { useCallback, useEffect, useState } from "react";
import { Stepper } from "./Stepper";
import { NumberPad, type PadRequest } from "./NumberPad";
import {
  getBodyweight,
  recordBodyweight,
  type BodyweightPoint,
} from "../lib/data";
import { formatStoredTwin } from "../lib/format";
import { reportError } from "../lib/errors";
import { useUnit } from "../hooks/useUnit";
import {
  fromDisplay,
  MAX_BODYWEIGHT_KG,
  stepKg,
  toDisplay,
  toStoredKg,
} from "../lib/units";

/** Where the stepper starts when there is no history to start it from. */
const FALLBACK_KG = 80;

/**
 * How long ago the last figure is, in the least precise words that still
 * answer "do I need to do this today".
 *
 * Same calendar-day comparison the rest of the app uses rather than a 24-hour
 * one: someone who weighed in at 07:00 yesterday and reads this at 08:00 today
 * has weighed in YESTERDAY, not "23 hours ago", and the whole point of the row
 * is to say whether today's is done.
 */
export function agoLabel(measuredAt: string, now: Date): string {
  const then = new Date(measuredAt);
  const days = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) /
      86_400_000,
  );
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  return `${Math.floor(days / 7)} weeks ago`;
}

export function BodyweightRow() {
  const unit = useUnit();
  const [latest, setLatest] = useState<BodyweightPoint | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [pad, setPad] = useState(false);
  const [kg, setKg] = useState(FALLBACK_KG);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await getBodyweight();
        if (cancelled) return;
        const first = data[0] ?? null;
        setLatest(first);
        // Open the stepper on the last known weight. Nobody's bodyweight is a
        // surprise to them, so the first tap should be a confirmation, not a
        // scroll up from 80.
        if (first !== null) setKg(first.weight_kg);
      } catch (e) {
        // Offline with no cache is the ordinary case on a new device. The row
        // still offers to record one; it just cannot say what the last was.
        reportError(e, "load bodyweight");
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(() => {
    const stored = toStoredKg(kg);
    setOpen(false);
    void recordBodyweight(stored)
      // Rendered from what was written rather than from a refetch: the refetch
      // is exactly what cannot run on a phone with no signal, and someone who
      // has just weighed in must see the row say so today.
      .then((p) => setLatest(p))
      .catch((e: unknown) => reportError(e, "record bodyweight"));
  }, [kg]);

  const padReq: PadRequest | null = pad
    ? {
        label: `BODYWEIGHT · ${unit.toUpperCase()}`,
        action: "SET WEIGHT",
        initial: String(toDisplay(kg, unit)),
        allowDecimal: true,
        onCommit: (v) => {
          setKg(Math.min(MAX_BODYWEIGHT_KG, Math.max(1, fromDisplay(v, unit))));
          setPad(false);
        },
        onCancel: () => setPad(false),
      }
    : null;

  // Nothing at all until the first read settles. A row that says "no weigh-ins
  // yet" for a moment and then contradicts itself is worse than a row that
  // arrives a beat late.
  if (!loaded) return null;

  const today =
    latest !== null && agoLabel(latest.measured_at, new Date()) === "today";

  return (
    <section className="rule-section">
      <div className="section-head">
        <span className="field-label">BODYWEIGHT · {unit.toUpperCase()}</span>
        {open && (
          <span className="section-meta">{formatStoredTwin(kg, unit)}</span>
        )}
      </div>

      {open ? (
        <>
          <Stepper
            label="bodyweight"
            inline
            display={String(toDisplay(kg, unit))}
            onTapValue={() => setPad(true)}
            value={kg}
            min={1}
            max={MAX_BODYWEIGHT_KG}
            onChange={setKg}
            steps={[
              { label: "−", delta: -stepKg(unit, true) },
              { label: "+", delta: stepKg(unit, true) },
            ]}
          />
          <div className="detail-actions">
            <button type="button" className="btn btn-primary" onClick={save}>
              Save
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div className="bw-row">
          <span className="bw-value">
            {latest === null ? (
              <span className="microcopy">No weigh-ins yet</span>
            ) : (
              <>
                {toDisplay(latest.weight_kg, unit)} {unit}
                <span className="bw-when">
                  {" · "}
                  {agoLabel(latest.measured_at, new Date())}
                  {latest.source === "session" && " · before training"}
                </span>
              </>
            )}
          </span>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setOpen(true)}
          >
            {today ? "Update" : "Weigh in"}
          </button>
        </div>
      )}

      {padReq && <NumberPad req={padReq} />}
    </section>
  );
}

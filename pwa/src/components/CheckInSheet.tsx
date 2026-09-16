// Check in.
//
// Three optional inputs, note first: how you feel in words, tags, energy.
// Every check-in is its own timestamped row, as often as someone wants.
// Pain opens three quick questions and files the check-in against an injury,
// and an injury last reported on an earlier day is asked about at the top.
import { useEffect, useMemo, useState } from "react";
import { Sheet } from "./Sheet";
import {
  BODY_REGIONS,
  buildCheckinOps,
  canSubmit,
  CHECKIN_TAGS,
  closeEpisodeOp,
  EMPTY_PAIN,
  episodeSide,
  IMPACT_CHOICES,
  injuryLabel,
  matchEpisode,
  mergeCheckins,
  pendingCheckins,
  SIDE_CHOICES,
  stillThere,
  toggleTag,
  withPending,
  type CheckinDraft,
} from "../lib/checkins";
import {
  getInjuries,
  getWeekCheckins,
  localDateOf,
} from "../lib/checkinHistory";
import { weekStartIso } from "../lib/sessionHistory";
import { formatSessionDate } from "../lib/format";
import { outbox } from "../lib/sync";
import { reportError, toast } from "../lib/errors";
import { uuid } from "../lib/uuid";
import type { CheckinRow, InjuryState } from "../lib/types";

interface CheckInSheetProps {
  userId: string;
  /** The device's date. The phone travels with the lifter. */
  localDate: string;
  onClose: () => void;
}

const EMPTY_DRAFT: CheckinDraft = {
  note: "",
  tags: [],
  energy: null,
  pain: EMPTY_PAIN,
};

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function CheckInSheet({
  userId,
  localDate,
  onClose,
}: CheckInSheetProps) {
  const [draft, setDraft] = useState<CheckinDraft>(EMPTY_DRAFT);
  const [injuries, setInjuries] = useState<InjuryState[]>([]);
  const [earlier, setEarlier] = useState<CheckinRow[]>([]);
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [inj, week, queue] = await Promise.all([
        getInjuries()
          .then((r) => r.data)
          .catch((e: unknown) => {
            reportError(e, "load injuries");
            return [] as InjuryState[];
          }),
        getWeekCheckins(weekStartIso(localDate))
          .then((r) => r.data)
          .catch(() => [] as CheckinRow[]),
        outbox.inspect().catch(() => []),
      ]);
      if (!live) return;
      setInjuries(withPending(inj, queue, userId, localDateOf));
      setEarlier(
        mergeCheckins(week, pendingCheckins(queue, userId)).filter(
          (r) => localDateOf(r.recorded_at) === localDate,
        ),
      );
    })();
    return () => {
      live = false;
    };
  }, [userId, localDate]);

  const asks = useMemo(
    () =>
      stillThere(injuries, localDate).filter(
        (e) => !answered.has(e.episode_id),
      ),
    [injuries, localDate, answered],
  );

  const painOn = draft.tags.includes("pain");
  const match =
    painOn && draft.pain.region !== null
      ? matchEpisode(injuries, draft.pain.region, episodeSide(draft.pain.side))
      : null;

  const toggle = (tag: CheckinDraft["tags"][number]) =>
    setDraft((d) => {
      const tags = toggleTag(d.tags, tag);
      // Pain off clears its answers, so a later Pain starts blank.
      return { ...d, tags, pain: tags.includes("pain") ? d.pain : EMPTY_PAIN };
    });

  const setPain = (patch: Partial<CheckinDraft["pain"]>) =>
    setDraft((d) => ({ ...d, pain: { ...d.pain, ...patch } }));

  const stillThereYes = (e: InjuryState) => {
    setAnswered((s) => new Set(s).add(e.episode_id));
    setDraft((d) => ({
      ...d,
      tags: d.tags.includes("pain") ? d.tags : toggleTag(d.tags, "pain"),
      pain: {
        region: e.body_region,
        side: e.side === "n/a" || e.side === null ? null : e.side,
        impact: d.pain.impact,
      },
    }));
  };

  const clearedUp = async (e: InjuryState) => {
    setAnswered((s) => new Set(s).add(e.episode_id));
    try {
      await outbox.enqueue(closeEpisodeOp(e.episode_id, localDate));
      toast(`Marked your ${injuryLabel(e)} as cleared up`);
    } catch (err) {
      reportError(err, "close injury");
    }
  };

  const checkIn = async () => {
    setSaving(true);
    const ops = buildCheckinOps(draft, {
      userId,
      now: new Date().toISOString(),
      today: localDate,
      injuries,
      newId: uuid,
    });
    try {
      await outbox.enqueueBatch(ops);
      toast("Checked in");
    } catch (e) {
      reportError(e, "save check-in");
      setSaving(false);
      return;
    }
    onClose();
  };

  return (
    <Sheet title="Check in" onClose={onClose} tall className="checkin-sheet">
      {asks.length > 0 && (
        <div className="checkin-still">
          {asks.map((e) => (
            <div className="checkin-still-row" key={e.episode_id}>
              <span>Still feeling your {injuryLabel(e)}?</span>
              <button
                type="button"
                className="chip"
                onClick={() => stillThereYes(e)}
              >
                Still there
              </button>
              <button
                type="button"
                className="chip"
                onClick={() => void clearedUp(e)}
              >
                Cleared up
              </button>
            </div>
          ))}
        </div>
      )}

      {earlier.length > 0 && (
        <div className="checkin-earlier" aria-label="Earlier today">
          <span>Earlier today</span>
          {earlier.map((r) => (
            <span key={r.id}>
              {timeOf(r.recorded_at)}
              <b>{r.energy ?? "–"}</b>
            </span>
          ))}
        </div>
      )}

      <div className="checkin-group">
        <label className="field-label" htmlFor="checkin-note">
          How are you feeling?
        </label>
        <textarea
          id="checkin-note"
          className="input"
          rows={2}
          maxLength={1000}
          value={draft.note}
          onChange={(e) => {
            const note = e.target.value;
            setDraft((d) => ({ ...d, note }));
          }}
          placeholder="Anything worth noting"
        />
      </div>

      <div className="checkin-group">
        <span className="field-label">Tags</span>
        <div className="chip-row" role="group" aria-label="Tags">
          {CHECKIN_TAGS.map((t) => {
            const on = draft.tags.includes(t.value);
            return (
              <button
                key={t.value}
                type="button"
                className={`chip${on ? " chip-on" : ""}${t.value === "pain" ? " chip-pain" : ""}`}
                aria-pressed={on}
                onClick={() => toggle(t.value)}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {painOn && (
          <div className="checkin-follow">
            <div className="checkin-group">
              <span className="field-label">Where</span>
              <div className="chip-row" role="group" aria-label="Where">
                {BODY_REGIONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    className={`chip${draft.pain.region === r ? " chip-on" : ""}`}
                    aria-pressed={draft.pain.region === r}
                    onClick={() =>
                      setPain({ region: draft.pain.region === r ? null : r })
                    }
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <div className="checkin-group">
              <span className="field-label">Side</span>
              <div className="checkin-seg" role="group" aria-label="Side">
                {SIDE_CHOICES.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    className={`chip${draft.pain.side === s.value ? " chip-on" : ""}`}
                    aria-pressed={draft.pain.side === s.value}
                    onClick={() =>
                      setPain({
                        side: draft.pain.side === s.value ? null : s.value,
                      })
                    }
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="checkin-group">
              <span className="field-label">Did it change training?</span>
              <div
                className="checkin-seg"
                role="group"
                aria-label="Did it change training?"
              >
                {IMPACT_CHOICES.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    className={`chip${draft.pain.impact === c.value ? " chip-on" : ""}`}
                    aria-pressed={draft.pain.impact === c.value}
                    onClick={() =>
                      setPain({
                        impact: draft.pain.impact === c.value ? null : c.value,
                      })
                    }
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
            {match && (
              <p className="checkin-hint">
                Adds to {injuryLabel(match)}, being tracked since{" "}
                {formatSessionDate(match.opened_on)}.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="checkin-group">
        <span className="field-label">Energy</span>
        <div className="checkin-scale" role="group" aria-label="Energy">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              className={`chip${draft.energy === n ? " chip-on" : ""}`}
              aria-pressed={draft.energy === n}
              aria-label={`Energy ${n} of 5`}
              onClick={() =>
                setDraft((d) => ({ ...d, energy: d.energy === n ? null : n }))
              }
            >
              {n}
            </button>
          ))}
        </div>
        <div className="checkin-ends">
          <span>drained</span>
          <span>full of it</span>
        </div>
      </div>

      <button
        type="button"
        className="btn btn-primary btn-block"
        disabled={!canSubmit(draft) || saving}
        onClick={() => void checkIn()}
      >
        Check in
      </button>
    </Sheet>
  );
}

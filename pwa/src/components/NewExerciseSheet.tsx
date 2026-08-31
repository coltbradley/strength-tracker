// Adding an exercise from the gym floor.
//
// The library is 873 seeded movements plus whatever has been added, and it
// still will not have everything: a machine only your gym owns, a physio's
// variation, or something filed under a name nobody searches for (a dumbbell
// lateral raise is in there as "Side Lateral Raise"). Without this, that
// movement is untrackable and the session it belongs to is incomplete.
//
// Four fields, not eleven. Name, what it works, what it uses, and whether it
// is a big movement or a small one — those are what the app actually reads:
// equipment drives the plate maths and the per-side default, muscles drive
// grouping, mechanic and category are how it reads back. Everything else the
// seed carries is decoration here and is left at a sane default.
import { useMemo, useState } from "react";
import { Sheet } from "./Sheet";
import { addCustomExercise } from "../lib/data";
import { rank } from "../lib/fuzzy";
import { reportError, toast } from "../lib/errors";
import type { ExerciseRow } from "../lib/types";

/** The equipment values the seed uses, so a custom row sorts and reads with
 *  the rest of the library rather than inventing a vocabulary. */
const EQUIPMENT = [
  "barbell",
  "dumbbell",
  "machine",
  "cable",
  "kettlebells",
  "bands",
  "body only",
  "other",
] as const;

const MUSCLES = [
  "quadriceps",
  "hamstrings",
  "glutes",
  "calves",
  "chest",
  "lats",
  "middle back",
  "lower back",
  "shoulders",
  "biceps",
  "triceps",
  "forearms",
  "abdominals",
  "adductors",
  "abductors",
  "traps",
  "neck",
] as const;

interface NewExerciseSheetProps {
  /** Prefilled from whatever was typed in the picker. */
  initialName: string;
  /** The whole library, for the duplicate check. */
  exercises: ExerciseRow[];
  /** They recognised one of the near-matches; use that instead of adding. */
  onPickExisting: (ex: ExerciseRow) => void;
  onCreated: (ex: ExerciseRow) => void;
  onClose: () => void;
}

export function NewExerciseSheet({
  initialName,
  exercises,
  onPickExisting,
  onCreated,
  onClose,
}: NewExerciseSheetProps) {
  const [name, setName] = useState(initialName);
  const [equipment, setEquipment] = useState<string>("dumbbell");
  const [muscle, setMuscle] = useState<string>("shoulders");
  const [compound, setCompound] = useState(false);
  const [busy, setBusy] = useState(false);

  // The duplicate check, live against the name as it is typed. A near-match
  // matters more here than anywhere else in the app: two rows for one movement
  // split its history in two and break the load prefill for both, and it is
  // invisible until weeks later when the chart has a hole in it. The seeded
  // library also names things its own way, so the thing someone is about to
  // add usually IS in there under a name they did not think to search.
  const near = useMemo(
    () => rank(exercises, name, (e) => e.name).slice(0, 5),
    [exercises, name],
  );

  const save = () => {
    if (busy) return;
    setBusy(true);
    addCustomExercise({
      name,
      primary_muscles: [muscle],
      equipment: equipment === "other" ? null : equipment,
      mechanic: compound ? "compound" : "isolation",
      category: "strength",
    })
      .then((ex) => {
        toast(`${ex.name} added to your library`);
        onCreated(ex);
      })
      .catch((e: unknown) => reportError(e, "add exercise"))
      .finally(() => setBusy(false));
  };

  return (
    <Sheet title="New exercise" onClose={onClose} tall>
      <div className="field-label">NAME</div>
      <input
        className="input"
        data-sheet-autofocus
        value={name}
        aria-label="exercise name"
        placeholder="Dumbbell Lateral Raise"
        onChange={(e) => setName(e.target.value)}
      />

      {near.length > 0 && (
        <div className="dupe-warn">
          <div className="field-label">ALREADY IN YOUR LIBRARY?</div>
          <div className="microcopy">
            Tap one to use it instead. Two entries for one movement split its
            history and break the weight it suggests you.
          </div>
          {near.map((e) => (
            <button
              key={e.id}
              type="button"
              className="week-row dupe-row"
              onClick={() => onPickExisting(e)}
            >
              <span className="week-label">{e.name}</span>
              <span className="week-state">
                {(e.equipment ?? "—").toUpperCase()}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="field-label">WHAT IT USES</div>
      <div className="seg">
        {EQUIPMENT.map((eq) => (
          <button
            key={eq}
            type="button"
            className={`seg-btn ${equipment === eq ? "seg-on" : ""}`}
            onClick={() => setEquipment(eq)}
          >
            {eq.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="microcopy">
        Sets the plate maths and whether weights are typed per side.
      </div>

      <div className="field-label">MAIN MUSCLE</div>
      <div className="seg">
        {MUSCLES.map((m) => (
          <button
            key={m}
            type="button"
            className={`seg-btn ${muscle === m ? "seg-on" : ""}`}
            onClick={() => setMuscle(m)}
          >
            {m.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="field-label">SIZE OF MOVEMENT</div>
      <div className="seg">
        <button
          type="button"
          className={`seg-btn ${compound ? "" : "seg-on"}`}
          onClick={() => setCompound(false)}
        >
          ISOLATION
        </button>
        <button
          type="button"
          className={`seg-btn ${compound ? "seg-on" : ""}`}
          onClick={() => setCompound(true)}
        >
          COMPOUND
        </button>
      </div>

      <button
        type="button"
        className="btn btn-primary btn-block"
        disabled={busy || name.trim().length === 0}
        onClick={save}
      >
        {busy
          ? "Adding…"
          : near.length > 0
            ? "None of those — add it anyway"
            : "Add to library"}
      </button>
      <div className="microcopy">
        Yours alone — it joins your library, not anyone else's.
      </div>
    </Sheet>
  );
}

// How to do this movement: the seed's two photos (start and end position) and
// its numbered steps, opened from the exercise name mid-session.
//
// A coach who programs a movement the lifter has never done hands them a name.
// TrainingPeaks and its kind hand them a clip; we have no clip and no budget
// for one, but the library this app seeded from ships photos and instructions
// for every one of its 873 exercises, and until now the seed threw both away.
//
// Photos are cross-origin and deliberately not cached by the service worker,
// so they are an online nicety and vanish quietly when they cannot load. The
// STEPS ride on the exercise row, which is cached like every other read, so
// once opened they are still there in a basement. A custom exercise has
// neither, and says so rather than showing an empty sheet.
import { useEffect, useState } from "react";
import { Sheet } from "./Sheet";
import { getExerciseDemo, type ExerciseDemo } from "../lib/data";
import { exerciseImageUrl } from "../lib/exerciseMedia";
import { reportError } from "../lib/errors";

interface ExerciseDemoSheetProps {
  exerciseId: string;
  exerciseName: string;
  onClose: () => void;
}

export function ExerciseDemoSheet({
  exerciseId,
  exerciseName,
  onClose,
}: ExerciseDemoSheetProps) {
  // undefined = still loading; null = no such exercise
  const [demo, setDemo] = useState<ExerciseDemo | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDemo(undefined);
    setFailed(false);
    getExerciseDemo(exerciseId)
      .then((r) => {
        if (!cancelled) setDemo(r.data);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setFailed(true);
        reportError(e, "load exercise demo");
      });
    return () => {
      cancelled = true;
    };
  }, [exerciseId]);

  const images = (demo?.images ?? [])
    .map(exerciseImageUrl)
    .filter((u): u is string => u !== null);
  const steps = demo?.instructions ?? [];
  const loaded = demo !== undefined;
  const empty = loaded && images.length === 0 && steps.length === 0;

  return (
    <Sheet title={exerciseName} onClose={onClose} className="demo-sheet">
      {!loaded && !failed && <p className="muted">Loading…</p>}
      {failed && (
        <p className="microcopy">
          Couldn’t load the demo. It needs a connection the first time; after
          that the steps stay on this phone.
        </p>
      )}
      {empty && (
        <p className="microcopy">
          No demo for this one. Photos and steps come with the seeded library;
          an exercise someone added by hand has neither.
        </p>
      )}
      {images.length > 0 && (
        <div className="demo-photos">
          {images.map((src, i) => (
            <img
              key={src}
              src={src}
              alt={`${exerciseName}, ${
                i === 0 ? "start" : i === 1 ? "end" : `frame ${i + 1}`
              } position`}
              loading="lazy"
              decoding="async"
              /* offline, or the host is down: the photo goes away rather than
                 leaving a broken-image glyph over the steps */
              onError={(e) => {
                e.currentTarget.hidden = true;
              }}
            />
          ))}
        </div>
      )}
      {steps.length > 0 && (
        <ol className="demo-steps">
          {steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
      {images.length > 0 && (
        <p className="microcopy">
          Steps are kept on this phone. Photos need a connection.
        </p>
      )}
    </Sheet>
  );
}

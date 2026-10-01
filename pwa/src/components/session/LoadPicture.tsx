// The picture in the middle of the focus screen: what is in front of the
// lifter right now. A bar with its plates, one or two dumbbells, a pin stack,
// or plain bodyweight. Every one of them is a button onto the one thing that
// changes it (the plate sheet, the one/two-dumbbell toggle, the machine
// switcher), so the drawing IS the control and no separate key duplicates it.
//
// Purely presentational: Session owns the numbers and every handler.

import type { PlateSplit } from "../../lib/plates";
import {
  dumbbellLook,
  dumbbellText,
  plateText,
  plateVisuals,
  type PlateVisual,
} from "../../lib/loadPicture";
import { formatPlate } from "../../lib/format";
import { toDisplay, type Unit } from "../../lib/units";

export type LoadPictureModel =
  | {
      kind: "plates";
      split: PlateSplit;
      baseKg: number;
      /** "Bar" for a barbell, "Sled" for a plate-loaded machine. */
      baseName: "Bar" | "Sled";
      /** False while a sled's weight has never been set: the picture then
       *  asks for it rather than drawing plates around a guessed zero. A bar
       *  is always known (it comes from the shared bar inventory). */
      baseKnown?: boolean;
      /** "A1 · " in a superset, so the drawing names whose load it is. */
      tag?: string;
      onOpen(): void;
    }
  | {
      kind: "dumbbell";
      /** the weight of ONE implement, kg */
      implementKg: number;
      /** the number as the lifter reads/typed it, in the unit shown; used for
       *  the words so an authored value is never re-derived from kg */
      displayLoad?: number;
      pair: boolean;
      word: "dumbbell" | "kettlebell";
      onToggle?(): void;
    }
  | {
      kind: "stack";
      totalKg: number;
      /** a plate-loaded alternative plausibly exists (Leg Press); a tap opens
       *  the switcher. Never offered for a cable. */
      canSwitch: boolean;
      tag?: string;
      onOpen?(): void;
    }
  | {
      kind: "bodyweight";
      addedOn: boolean;
      /** a timed hold rather than counted reps */
      timed?: boolean;
      onAddLoad?(): void;
    };

/** One side of the bar. `outerFirst` draws the smallest plate first, which
 *  is the left side read left-to-right; the right side is heaviest first. */
function PlateStack({ plates, outerFirst }: { plates: PlateVisual[]; outerFirst: boolean }) {
  const order = outerFirst ? [...plates].reverse() : plates;
  return (
    <>
      {order.map((p, i) => (
        <span
          key={i}
          className={`lp-plate lp-c-${p.cls}`}
          style={{ height: p.height, width: p.width }}
        />
      ))}
    </>
  );
}

export function PlateDiagram({
  split,
  unit,
  compact = false,
}: {
  split: PlateSplit;
  unit: Unit;
  compact?: boolean;
}) {
  const plates = plateVisuals(split, unit);
  if (compact) {
    // the rest card's thumbnail: one side only, collar end on the right
    return (
      <span className="lp-bar lp-bar-compact" aria-hidden="true">
        <PlateStack plates={plates} outerFirst />
        <span className="lp-shaft lp-shaft-short" />
      </span>
    );
  }
  return (
    <span className="lp-bar" aria-hidden="true">
      <span className="lp-sleeve-end" />
      <PlateStack plates={plates} outerFirst />
      <span className="lp-shaft" />
      <PlateStack plates={plates} outerFirst={false} />
      <span className="lp-sleeve-end" />
    </span>
  );
}

/**
 * A generic weight stack: equal plates and a pin rod. It deliberately has no
 * lifted plates and no pin position. A stack's per-plate weight differs by
 * machine, so any position drawn from the load would be invented stack
 * metadata; the caption ("Pin at 40 lb") is the claim, this is only the
 * silhouette that says "stack machine".
 */
export function StackDrawing() {
  return (
    <span className="lp-stack" aria-hidden="true">
      {Array.from({ length: STACK_PLATES }, (_, i) => (
        <span key={i} className="lp-stack-plate" />
      ))}
      <span className="lp-stack-rod" />
    </span>
  );
}

const STACK_PLATES = 7;

function Dumbbell({ cls, height }: { cls: string; height: number }) {
  return (
    <span className="lp-db" aria-hidden="true">
      <span className={`lp-db-head lp-c-${cls}`} style={{ height }} />
      <span className="lp-db-handle" />
      <span className={`lp-db-head lp-c-${cls}`} style={{ height }} />
    </span>
  );
}

export function LoadPicture({ model, unit }: { model: LoadPictureModel; unit: Unit }) {
  switch (model.kind) {
    case "plates": {
      const known = model.baseKnown !== false;
      const text = known
        ? plateText(model.split, model.baseKg, unit, model.baseName)
        : `${model.baseName} weight not set`;
      const caption = known
        ? `${model.baseName} ${formatPlate(model.baseKg, unit)} ${unit} · change ›`
        : `Set ${model.baseName.toLowerCase()} weight ›`;
      return (
        <button
          type="button"
          className="load-picture"
          onClick={model.onOpen}
          aria-label={
            known
              ? `${model.tag ?? ""}${text}. ${model.baseName} ${formatPlate(model.baseKg, unit)} ${unit}. Open plates`
              : `${model.tag ?? ""}${text}. Open plates to set it`
          }
        >
          <PlateDiagram
            split={known ? model.split : { ...model.split, plates: [] }}
            unit={unit}
          />
          <span className="lp-text">
            {model.tag}
            {text}
          </span>
          <span className="lp-caption">{caption}</span>
        </button>
      );
    }
    case "dumbbell": {
      const look = dumbbellLook(model.implementKg);
      const text = dumbbellText(
        model.implementKg,
        model.pair,
        unit,
        model.word,
        model.displayLoad,
      );
      const body = (
        <>
          <span className="lp-dbs" aria-hidden="true">
            <Dumbbell cls={look.cls} height={look.height} />
            {model.pair && <span className="lp-db-plus">+</span>}
            {model.pair && <Dumbbell cls={look.cls} height={look.height} />}
          </span>
          <span className="lp-text">{text}</span>
        </>
      );
      if (!model.onToggle) return <div className="load-picture">{body}</div>;
      return (
        <button
          type="button"
          className="load-picture"
          onClick={model.onToggle}
          aria-label={`${text}. Switch to ${model.pair ? `one ${model.word}` : `two ${model.word}s`}`}
        >
          {body}
          <span className="lp-caption">
            Tap for {model.pair ? `one ${model.word}` : `two ${model.word}s`}
          </span>
        </button>
      );
    }
    case "stack": {
      const text = `${model.tag ?? ""}Pin at ${toDisplay(model.totalKg, unit)} ${unit}`;
      const sub = model.canSwitch
        ? "Pin-stack machine · tap to switch to the plate sled"
        : "Pin-stack machine · the number on the pin is the load";
      const body = (
        <>
          <StackDrawing />
          <span className="lp-stack-words">
            <span className="lp-text">{text}</span>
            <span className="lp-caption">{sub}</span>
          </span>
        </>
      );
      return model.canSwitch && model.onOpen ? (
        <button type="button" className="load-picture load-picture-row" onClick={model.onOpen}>
          {body}
        </button>
      ) : (
        <div className="load-picture load-picture-row">{body}</div>
      );
    }
    case "bodyweight":
      return (
        <div className="load-picture-bw">
          <span className="lp-bw-title">Bodyweight</span>
          <span className="lp-caption">
            {model.addedOn
              ? model.timed
                ? "Timed hold. The added load is logged with each set."
                : "Reps count most. The added load is logged with each set."
              : model.timed
                ? "Timed hold. Your bodyweight isn’t added to the load."
                : "Reps only. Your bodyweight isn’t added to the load."}
          </span>
          {!model.addedOn && model.onAddLoad && (
            <button type="button" className="text-link" onClick={model.onAddLoad}>
              + Add load (belt or vest)
            </button>
          )}
        </div>
      );
  }
}

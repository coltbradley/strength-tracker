// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ExercisePicker } from "./ExercisePicker";
import type { ExerciseRow } from "../lib/types";

afterEach(cleanup);

const ex = (id: string, name: string) =>
  ({ id, name }) as unknown as ExerciseRow;
const LIB = [ex("sq", "Back Squat"), ex("bp", "Bench Press"), ex("cu", "Curl")];

describe("UI-12: ExercisePicker initialQuery", () => {
  it("opens already filtered by the query it was handed", () => {
    render(
      <ExercisePicker
        title="EXERCISE"
        exercises={LIB}
        initialQuery="squat"
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByDisplayValue("squat")).toBeTruthy();
    expect(screen.getByText("Back Squat")).toBeTruthy();
    expect(screen.queryByText("Curl")).toBeNull();
  });

  it("starts blank without one", () => {
    render(
      <ExercisePicker
        title="EXERCISE"
        exercises={LIB}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Curl")).toBeTruthy();
  });
});

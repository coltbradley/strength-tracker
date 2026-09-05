// @vitest-environment jsdom
// The sheet as a lifter meets it: a seeded movement shows its photos and
// steps, a custom one says so instead of rendering nothing, and no image path
// from the database ever becomes a URL on a host we did not choose.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const getExerciseDemo = vi.fn();
vi.mock("../lib/data", () => ({
  getExerciseDemo: (id: string) => getExerciseDemo(id),
}));
vi.mock("../lib/errors", () => ({ reportError: vi.fn() }));

import { ExerciseDemoSheet } from "./ExerciseDemoSheet";
import { EXERCISE_IMAGE_BASE } from "../lib/exerciseMedia";

afterEach(() => {
  cleanup();
  getExerciseDemo.mockReset();
});

const open = (id = "Barbell_Squat", name = "Barbell Squat") =>
  render(
    <ExerciseDemoSheet exerciseId={id} exerciseName={name} onClose={() => {}} />,
  );

describe("ExerciseDemoSheet", () => {
  it("shows the seed's photos and numbered steps", async () => {
    getExerciseDemo.mockResolvedValue({
      data: {
        name: "Barbell Squat",
        images: ["Barbell_Squat/0.jpg", "Barbell_Squat/1.jpg"],
        instructions: ["Set the bar on your back.", "Squat.", "Stand."],
      },
      fromCache: false,
      stale: null,
    });
    open();
    await waitFor(() =>
      expect(screen.getAllByRole("listitem")).toHaveLength(3),
    );
    const imgs = screen.getAllByRole("img") as HTMLImageElement[];
    expect(imgs.map((i) => i.src)).toEqual([
      `${EXERCISE_IMAGE_BASE}Barbell_Squat/0.jpg`,
      `${EXERCISE_IMAGE_BASE}Barbell_Squat/1.jpg`,
    ]);
    expect(imgs[0]!.alt).toMatch(/start position/);
    expect(imgs[1]!.alt).toMatch(/end position/);
  });

  it("says so for a custom exercise instead of showing an empty sheet", async () => {
    getExerciseDemo.mockResolvedValue({
      data: { name: "Pendulum Squat", images: [], instructions: [] },
      fromCache: false,
      stale: null,
    });
    open("Pendulum_Squat", "Pendulum Squat");
    await screen.findByText(/No demo for this one/);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("never turns a non-path into an image, whatever the row says", async () => {
    getExerciseDemo.mockResolvedValue({
      data: {
        name: "X",
        images: ["https://evil.example/pixel.jpg", "Barbell_Squat/0.jpg"],
        instructions: ["one"],
      },
      fromCache: false,
      stale: null,
    });
    open();
    await screen.findByText("one");
    const imgs = screen.getAllByRole("img") as HTMLImageElement[];
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.src.startsWith(EXERCISE_IMAGE_BASE)).toBe(true);
  });

  it("reports a failed load and says it needed a connection", async () => {
    getExerciseDemo.mockRejectedValue(new Error("boom"));
    open();
    await screen.findByText(/Couldn’t load the demo/);
  });
});

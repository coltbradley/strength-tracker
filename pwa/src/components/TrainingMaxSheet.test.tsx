// @vitest-environment jsdom
//
// PLAN-5: closing the sheet after a TM write used to call
// window.location.reload(), and the gear is reachable mid-session, so staged
// reps, load and a half-typed note went with it. It now announces the change
// on the plan-changed channel and closes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { TrainingMaxSheet } from "./TrainingMaxSheet";
import { onPlanChanged } from "../lib/planChanges";

const h = vi.hoisted(() => ({ setTrainingMax: vi.fn() }));

vi.mock("../lib/data", async (orig) => ({
  ...(await orig<typeof import("../lib/data")>()),
  getExercises: () => Promise.resolve({ data: [], fromCache: false }),
  getTrainingMaxes: () =>
    Promise.resolve({ data: [], fromCache: false, stale: null }),
  getUnresolvedTmExercises: () =>
    Promise.resolve([{ exercise_id: "bench", exercise_name: "Bench Press" }]),
  setTrainingMax: h.setTrainingMax,
}));

const reload = vi.fn();
let unsubscribe: (() => void) | null = null;
const planChanged = vi.fn();

beforeEach(() => {
  h.setTrainingMax.mockReset();
  h.setTrainingMax.mockResolvedValue(undefined);
  reload.mockReset();
  planChanged.mockReset();
  vi.spyOn(window, "location", "get").mockReturnValue({
    ...window.location,
    reload,
  } as unknown as Location);
  unsubscribe = onPlanChanged(planChanged);
});

afterEach(() => {
  unsubscribe?.();
  cleanup();
  vi.restoreAllMocks();
});

async function setBenchTm() {
  fireEvent.click(await screen.findByRole("button", { name: /Bench Press/ }));
  for (const k of ["1", "0", "0"])
    fireEvent.click(screen.getByRole("button", { name: k }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "SET TM" }));
  });
  await vi.waitFor(() => expect(h.setTrainingMax).toHaveBeenCalled());
}

describe("TrainingMaxSheet", () => {
  it("PLAN-5: closing after a write notifies plan consumers and never reloads the page", async () => {
    const onClose = vi.fn();
    render(<TrainingMaxSheet onClose={onClose} />);
    await setBenchTm();
    expect(planChanged).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: /close/i })[0]!);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(planChanged).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it("closing without a change announces nothing", async () => {
    const onClose = vi.fn();
    render(<TrainingMaxSheet onClose={onClose} />);
    await screen.findByRole("button", { name: /Bench Press/ });
    fireEvent.click(screen.getAllByRole("button", { name: /close/i })[0]!);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(planChanged).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});

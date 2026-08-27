// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Sheet } from "./Sheet";
import { ExercisePicker } from "./ExercisePicker";
import type { ExerciseRow } from "../lib/types";

// RTL's automatic cleanup needs a global afterEach; vitest globals are off.
afterEach(() => {
  cleanup();
  document.getElementById("root")?.remove();
});

/** index.html's app root — <Sheet> makes it inert while a sheet is open. */
function appRoot() {
  const root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);
  return root;
}

/** A sheet with a real opener, so focus restore has somewhere to go back to. */
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open me
      </button>
      {open && (
        <Sheet title="PLATES" onClose={() => setOpen(false)}>
          <button type="button">first</button>
          <button type="button">last</button>
        </Sheet>
      )}
    </>
  );
}

describe("Sheet", () => {
  it("is a modal dialog named by a real heading", () => {
    render(
      <Sheet title="SETTINGS" onClose={() => undefined}>
        <button type="button">a control</button>
      </Sheet>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");

    const heading = screen.getByRole("heading", { name: "SETTINGS" });
    expect(heading.tagName).toBe("H2");
    expect(dialog.getAttribute("aria-labelledby")).toBe(heading.id);
  });

  it("moves focus into the sheet and restores it to the opener on close", () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "open me" });
    opener.focus();
    fireEvent.click(opener);

    expect(document.activeElement).toBe(screen.getByRole("dialog"));

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes on Escape, on the backdrop, and on CLOSE — but not on a click inside", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Sheet title="PLATES" onClose={onClose}>
        <button type="button">inside</button>
      </Sheet>,
    );
    void container;

    fireEvent.click(screen.getByRole("button", { name: "inside" }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "CLOSE" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);

    const backdrop = screen.getByRole("dialog").parentElement as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("traps Tab and Shift+Tab inside the sheet", () => {
    render(
      <Sheet title="PLATES" onClose={() => undefined}>
        <button type="button">first</button>
        <button type="button">last</button>
      </Sheet>,
    );
    const close = screen.getByRole("button", { name: "CLOSE" });
    const first = screen.getByRole("button", { name: "first" });
    const last = screen.getByRole("button", { name: "last" });

    // CLOSE is the first control in the head, so the cycle is CLOSE → … → last
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    // an interior stop is left to the browser
    first.focus();
    fireEvent.keyDown(first, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

  it("makes the app root inert while open and releases it on close", () => {
    const root = appRoot();
    const { unmount } = render(
      <Sheet title="PLATES" onClose={() => undefined}>
        <button type="button">inside</button>
      </Sheet>,
    );
    expect(root.hasAttribute("inert")).toBe(true);
    unmount();
    expect(root.hasAttribute("inert")).toBe(false);
  });

  it("keeps the app root inert until the LAST of two nested sheets closes", () => {
    const root = appRoot();
    function Nested({ padOpen }: { padOpen: boolean }) {
      return (
        <Sheet title="SETTINGS" onClose={() => undefined}>
          <button type="button">a row</button>
          {padOpen && (
            <Sheet title="LOAD" onClose={() => undefined}>
              <button type="button">7</button>
            </Sheet>
          )}
        </Sheet>
      );
    }
    const { rerender, unmount } = render(<Nested padOpen />);
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    expect(root.hasAttribute("inert")).toBe(true);

    rerender(<Nested padOpen={false} />);
    expect(root.hasAttribute("inert")).toBe(true);

    unmount();
    expect(root.hasAttribute("inert")).toBe(false);
  });
});

const LIBRARY: ExerciseRow[] = [
  {
    id: "back_squat",
    name: "Back Squat",
    equipment: "barbell",
  } as ExerciseRow,
  {
    id: "leg_press",
    name: "Leg Press",
    equipment: "machine",
  } as ExerciseRow,
  {
    id: "plank",
    name: "Plank",
    equipment: null,
  } as ExerciseRow,
];

describe("ExercisePicker", () => {
  it("focuses the search field, filters, and reports a miss", () => {
    const onPick = vi.fn();
    render(
      <ExercisePicker
        title="ADD EXERCISE"
        exercises={LIBRARY}
        onPick={onPick}
        onClose={() => undefined}
      />,
    );
    const search = screen.getByLabelText("search exercises");
    expect(document.activeElement).toBe(search);
    // the head states the library size once it is known
    screen.getByRole("heading", { name: "ADD EXERCISE · 3 IN LIBRARY" });

    fireEvent.change(search, { target: { value: "squa" } });
    fireEvent.click(screen.getByRole("button", { name: /Back Squat/ }));
    expect(onPick).toHaveBeenCalledWith(LIBRARY[0]);

    fireEvent.change(search, { target: { value: "zercher" } });
    screen.getByText("No exercise matches “zercher”.");
  });

  it("says so when the library could not be loaded offline", () => {
    render(
      <ExercisePicker
        title="ADD EXERCISE"
        exercises={[]}
        failed
        onPick={() => undefined}
        onClose={() => undefined}
      />,
    );
    screen.getByText(/unavailable offline/);
  });

  it("leads with badged exercises when nothing is typed", () => {
    render(
      <ExercisePicker
        title="EXERCISE"
        exercises={LIBRARY}
        badge={(ex) => (ex.id === "plank" ? "LOGGED" : null)}
        preferBadged
        onPick={() => undefined}
        onClose={() => undefined}
      />,
    );
    const rows = screen
      .getAllByRole("button")
      .filter((b) => b.className.includes("drawer-row"));
    expect(rows[0].textContent).toContain("Plank");
    expect(rows[0].textContent).toContain("LOGGED");
  });
});

// @vitest-environment jsdom
//
// A toast is informational: it has no buttons, no dismiss control, nothing to
// tap. Anchored to the top of the VIEWPORT it sat directly on the topbar and,
// being a real element in the hit-test, swallowed every tap aimed at the
// settings gear and the wordmark's go-to-Today button for the 4.5s it lived —
// longer with three stacked. An error toast is exactly when someone reaches
// for settings, so those seconds landed at the worst moment.
//
// jsdom computes no layout, so the position half is pinned in CSS review and
// by the live occlusion sweep. What IS testable here is the part that makes
// the bug impossible regardless of layout: the overlay must never be in the
// hit path, and it must render below whatever the shell publishes as its
// topbar height.
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { Toasts } from "./Toasts";
import { toast } from "../lib/errors";

afterEach(cleanup);

describe("Toasts", () => {
  it("renders nothing until something is reported", () => {
    const { container } = render(<Toasts />);
    expect(container.querySelector(".toasts")).toBeNull();
  });

  it("is not in the hit path — it can never swallow a tap", () => {
    const { container } = render(<Toasts />);
    act(() => toast("something happened", "error"));

    const overlay = container.querySelector(".toasts");
    expect(overlay).not.toBeNull();
    // The class carries the guarantee; the rule lives in styles.css beside a
    // comment naming this bug. A toast gaining an interactive control (a
    // dismiss X) must re-enable pointer-events on THAT control only.
    expect(overlay!.querySelectorAll("button, a[href], input")).toHaveLength(0);
  });

  it("stacks at most three and drops the oldest", () => {
    const { container } = render(<Toasts />);
    act(() => {
      toast("one");
      toast("two");
      toast("three");
      toast("four");
    });
    const shown = Array.from(container.querySelectorAll(".toast")).map(
      (n) => n.textContent,
    );
    expect(shown).toEqual(["two", "three", "four"]);
  });

  it("marks errors so they are styled apart from info", () => {
    const { container } = render(<Toasts />);
    act(() => toast("bad thing", "error"));
    expect(container.querySelector(".toast-error")).not.toBeNull();
  });
});

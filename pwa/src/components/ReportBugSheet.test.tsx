// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ReportBugSheet } from "./ReportBugSheet";

afterEach(cleanup);
beforeEach(() => {
  // jsdom has no matchMedia; the diagnostics read display-mode from it
  window.matchMedia = ((q: string) => ({ matches: false, media: q })) as unknown as typeof window.matchMedia;
});

describe("ReportBugSheet", () => {
  it("UI-07: the textarea has a stable accessible name", () => {
    render(<ReportBugSheet userId={null} route="/" onClose={() => undefined} />);
    expect(screen.getByRole("textbox", { name: "What went wrong" })).toBeTruthy();
  });

  it("UI-10: does not tell people to drag the header buttons", () => {
    render(<ReportBugSheet userId={null} route="/" onClose={() => undefined} />);
    expect(document.body.textContent ?? "").not.toMatch(/drag/i);
  });
});

// @vitest-environment jsdom
// D2: the Report icon carried a 9px "1" badge that read as "1 report" but was
// the outbox count. The count lives on the sync chip now; Report is just Report.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("../hooks/useFabDrag", () => ({ useOnline: () => true }));
vi.mock("../lib/coachAccess", () => ({
  getCoachAccess: () => Promise.resolve({ enabled: true }),
}));
vi.mock("./CoachSheet", () => ({ CoachSheet: () => null }));
vi.mock("./ReportBugSheet", () => ({ ReportBugSheet: () => null }));
vi.mock("../hooks/useOutboxStatus", () => ({
  useOutboxStatus: () => ({ pending: 4, dead: 0, held: 0, state: "idle", lastError: null }),
}));

import { FabDock } from "./FabDock";

afterEach(() => cleanup());

describe("FabDock", () => {
  it("shows no count badge on the Report icon even with writes queued", () => {
    render(<FabDock userId="u" route="/session" />);
    const report = screen.getByRole("button", { name: "report a problem" });
    expect(report.textContent).toBe("Report");
    expect(report.querySelector(".fab-queue")).toBeNull();
  });
});

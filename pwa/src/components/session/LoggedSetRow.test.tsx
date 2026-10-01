// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LoggedSetRow } from "./LoggedSetRow";
import { RestLastSetCard } from "./RestLastSetCard";

afterEach(cleanup);

describe("correction waiting to send (F1)", () => {
  const note = "Correction waiting to send. The original stays live on the server until it lands.";

  it("marks the replacement row in List", () => {
    render(<LoggedSetRow label="2" position="set 2" text="100 kg x 5" pairNote={note} />);
    expect(screen.getByText(note)).toBeTruthy();
  });

  it("marks the LAST SET card", () => {
    render(
      <RestLastSetCard line="Bench Press · set 2 · 100 kg x 5" receipt="On this phone" pairNote={note} onFix={() => undefined} />,
    );
    expect(screen.getByText(note)).toBeTruthy();
  });

  it("shows nothing extra for an ordinary set", () => {
    const { container } = render(<LoggedSetRow label="1" position="set 1" text="100 kg x 5" />);
    expect(container.querySelector(".ledger-set-pair")).toBeNull();
  });
});

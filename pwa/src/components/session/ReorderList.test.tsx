// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { ReorderList, type ReorderItem } from "./ReorderList";

afterEach(cleanup);

// jsdom has no PointerEvent, so fireEvent would drop pointerId/clientY.
if (typeof globalThis.PointerEvent === "undefined") {
  class PointerEventShim extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  (globalThis as unknown as { PointerEvent: unknown }).PointerEvent =
    PointerEventShim;
}

const item = (
  key: string,
  title: string,
  sub: string,
  state: ReorderItem["lines"][number]["state"],
  extra: Partial<ReorderItem> = {},
): ReorderItem => ({
  key,
  lines: [{ key, title, subtitle: sub, state }],
  meta: "0/3",
  ...extra,
});

const base: ReorderItem[] = [
  item("a", "Squat", "3 × 5", "current"),
  item("b", "Bench", "3 × 8", "next"),
  item("c", "Row", "3 × 10", "upcoming"),
];

function Harness({ onSelect }: { onSelect?: (k: string) => void }) {
  const [items, setItems] = useState(base);
  return (
    <ReorderList
      items={items}
      onSelect={onSelect}
      onMove={(from, to) =>
        setItems((cur) => {
          const next = [...cur];
          next.splice(to, 0, next.splice(from, 1)[0]);
          return next;
        })
      }
    />
  );
}

const titles = () =>
  screen.getAllByRole("listitem").map((li) => li.querySelector(".reorder-line")?.getAttribute("aria-label")?.split(" — ")[0]);

describe("ReorderList", () => {
  it("moves a row with ArrowDown / ArrowUp on its handle, announces it and keeps focus", () => {
    render(<Harness />);
    const handle = () => screen.getByRole("button", { name: /^Reorder Squat/ });
    handle().focus();
    fireEvent.keyDown(handle(), { key: "ArrowDown" });
    expect(titles()).toEqual(["Bench", "Squat", "Row"]);
    expect(screen.getByRole("status").textContent).toBe(
      "Squat moved to position 2 of 3",
    );
    expect(document.activeElement).toBe(handle());
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect(titles()).toEqual(["Squat", "Bench", "Row"]);
  });

  it("ignores arrows at the ends", () => {
    const onMove = vi.fn();
    render(<ReorderList items={base} onMove={onMove} />);
    fireEvent.keyDown(screen.getByRole("button", { name: /^Reorder Squat/ }), {
      key: "ArrowUp",
    });
    fireEvent.keyDown(screen.getByRole("button", { name: /^Reorder Row/ }), {
      key: "ArrowDown",
    });
    expect(onMove).not.toHaveBeenCalled();
  });

  it("tapping the row body selects, tapping the handle does not", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "Bench — next" }));
    expect(onSelect).toHaveBeenCalledWith("b");
    fireEvent.click(screen.getByRole("button", { name: /^Reorder Bench/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("drags by pointer and reports one move on release", () => {
    const onMove = vi.fn();
    render(<ReorderList items={base} onMove={onMove} />);
    // jsdom has no layout: three 50px rows stacked from y=0
    screen.getAllByRole("listitem").forEach((li, i) => {
      li.getBoundingClientRect = () =>
        ({ top: i * 50, height: 50, bottom: i * 50 + 50 }) as DOMRect;
    });
    const handle = screen.getByRole("button", { name: /^Reorder Squat/ });
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 25, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 130 });
    expect(onMove).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 130 });
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith(0, 2);
  });

  it("a cancelled or unmoved drag reports nothing", () => {
    const onMove = vi.fn();
    render(<ReorderList items={base} onMove={onMove} />);
    const handle = screen.getByRole("button", { name: /^Reorder Squat/ });
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 25, button: 0 });
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    fireEvent.pointerDown(handle, { pointerId: 2, clientY: 25, button: 0 });
    fireEvent.pointerUp(handle, { pointerId: 2, clientY: 25 });
    expect(onMove).not.toHaveBeenCalled();
  });

  it("moves with the visible Move up / Move down buttons and disables them at the ends", () => {
    const onMove = vi.fn();
    render(<ReorderList items={base} onMove={onMove} />);
    expect(
      (screen.getByRole("button", { name: "Move Squat up" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Move Row down" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Move Bench down" }));
    expect(onMove).toHaveBeenCalledWith(1, 2);
  });

  it("says so when the caller refuses a move", () => {
    render(<ReorderList items={base} onMove={() => false} />);
    fireEvent.click(screen.getByRole("button", { name: "Move Bench up" }));
    expect(screen.getByRole("status").textContent).toMatch(/cannot move there/);
  });

  it("honours canMoveUp / canMoveDown from the caller", () => {
    const items = [
      item("a", "Squat", "", "current", { canMoveDown: false }),
      item("b", "Bench", "", "next"),
    ];
    render(<ReorderList items={items} onMove={vi.fn()} />);
    expect(
      (screen.getByRole("button", { name: "Move Squat down" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("M5: a row grabbed low in its box can still be dragged up", () => {
    const onMove = vi.fn();
    render(<ReorderList items={base} onMove={onMove} />);
    screen.getAllByRole("listitem").forEach((li, i) => {
      li.getBoundingClientRect = () =>
        ({ top: i * 50, height: 50, bottom: i * 50 + 50 }) as DOMRect;
    });
    const handle = screen.getByRole("button", { name: /^Reorder Row/ });
    // grab the third row near its bottom, drag up past the first row's middle
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 140, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 10 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 10 });
    expect(onMove).toHaveBeenCalledWith(2, 0);
  });

  it("a superset block lists each member as its own jump button", () => {
    const onSelect = vi.fn();
    const items: ReorderItem[] = [
      {
        key: "a1",
        lines: [
          { key: "a1", title: "A1 · Curl", state: "current" },
          { key: "a2", title: "A2 · Press", state: "next" },
        ],
      },
    ];
    render(<ReorderList items={items} onMove={vi.fn()} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "A2 · Press — next" }));
    expect(onSelect).toHaveBeenCalledWith("a2");
  });

  it("shows a locked line disabled rather than inert", () => {
    const items: ReorderItem[] = [
      { key: "a", lines: [{ key: "a", title: "Squat", locked: true }] },
    ];
    render(<ReorderList items={items} onMove={vi.fn()} />);
    expect(
      (screen.getByRole("button", { name: "Squat" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

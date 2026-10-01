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

const base: ReorderItem[] = [
  { key: "a", title: "Squat", subtitle: "3 × 5", meta: "0/3", state: "current" },
  { key: "b", title: "Bench", subtitle: "3 × 8", meta: "0/3", state: "next" },
  { key: "c", title: "Row", subtitle: "3 × 10", meta: "0/3", state: "upcoming" },
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
  screen.getAllByRole("listitem").map((li) => li.querySelector(".reorder-title")?.textContent);

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
});

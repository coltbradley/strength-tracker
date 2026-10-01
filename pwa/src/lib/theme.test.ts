// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reloadSettings, resetAllSettings, setSetting } from "./settings";
import { applyTheme, resolveTheme, startTheme } from "./theme";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

/** A controllable matchMedia: flip() fires the registered change listeners. */
function stubSystem(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<() => void>();
  const mq = {
    get matches() {
      return dark;
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal("matchMedia", () => mq);
  return {
    listeners,
    flip(next: boolean) {
      dark = next;
      for (const fn of listeners) fn();
    },
  };
}

const theme = () => document.documentElement.dataset.theme;
const metaColor = () =>
  document.querySelector('meta[name="theme-color"]')?.getAttribute("content");

let stop: (() => void) | null = null;

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  reloadSettings();
  document.head.innerHTML = '<meta name="theme-color" content="#f7f6fa">';
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
});

afterEach(() => {
  stop?.();
  stop = null;
  resetAllSettings();
  vi.unstubAllGlobals();
  reloadSettings();
});

describe("resolveTheme", () => {
  it("returns explicit choices regardless of the system", () => {
    stubSystem(true);
    expect(resolveTheme("light")).toBe("light");
    stubSystem(false);
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("follows prefers-color-scheme for system", () => {
    stubSystem(true);
    expect(resolveTheme("system")).toBe("dark");
    stubSystem(false);
    expect(resolveTheme("system")).toBe("light");
  });

  it("falls back to light when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(resolveTheme("system")).toBe("light");
  });
});

describe("applyTheme", () => {
  it("sets data-theme and color-scheme", () => {
    applyTheme("dark");
    expect(theme()).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("copies the resolved --paper token into the theme-color meta", () => {
    document.documentElement.style.setProperty("--paper", " #16131c ");
    applyTheme("dark");
    expect(metaColor()).toBe("#16131c");
  });

  it("leaves the meta alone when the token is unavailable", () => {
    applyTheme("dark");
    expect(metaColor()).toBe("#f7f6fa");
  });
});

describe("startTheme", () => {
  it("defaults to light", () => {
    stubSystem(true); // a dark phone does not change the default
    stop = startTheme();
    expect(theme()).toBe("light");
  });

  it("applies a stored dark setting immediately", () => {
    stubSystem(false);
    setSetting("appearance", "dark");
    stop = startTheme();
    expect(theme()).toBe("dark");
  });

  it("re-applies when the setting changes", () => {
    stubSystem(false);
    stop = startTheme();
    expect(theme()).toBe("light");
    setSetting("appearance", "dark");
    expect(theme()).toBe("dark");
    setSetting("appearance", "light");
    expect(theme()).toBe("light");
  });

  it("tracks the OS preference only while the choice is system", () => {
    const sys = stubSystem(false);
    setSetting("appearance", "system");
    stop = startTheme();
    expect(theme()).toBe("light");
    sys.flip(true);
    expect(theme()).toBe("dark");
    sys.flip(false);
    expect(theme()).toBe("light");

    setSetting("appearance", "light");
    sys.flip(true);
    expect(theme()).toBe("light");
  });

  it("switching to system picks up the current OS value", () => {
    stubSystem(true);
    stop = startTheme();
    setSetting("appearance", "system");
    expect(theme()).toBe("dark");
  });

  it("stops listening when torn down", () => {
    const sys = stubSystem(false);
    setSetting("appearance", "system");
    const off = startTheme();
    off();
    expect(sys.listeners.size).toBe(0);
    sys.flip(true);
    expect(theme()).toBe("light");
  });
});

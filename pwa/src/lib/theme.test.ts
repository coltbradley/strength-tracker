// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getSetting, reloadSettings, resetAllSettings, setSetting } from "./settings";
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

describe("startTheme on Safari < 14 (MediaQueryList without EventTarget)", () => {
  it("falls back to addListener/removeListener instead of throwing", () => {
    let dark = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", () => ({
      get matches() {
        return dark;
      },
      addListener: (fn: () => void) => listeners.add(fn),
      removeListener: (fn: () => void) => listeners.delete(fn),
    }));
    setSetting("appearance", "system");
    const off = startTheme();
    expect(theme()).toBe("light");
    dark = true;
    for (const fn of listeners) fn();
    expect(theme()).toBe("dark");
    off();
    expect(listeners.size).toBe(0);
  });
});

// index.html's pre-paint script is a hand-mirrored copy of the settings read +
// resolveTheme(). Run the REAL script against what settings.ts really writes.
describe("index.html pre-paint script", () => {
  const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
  const code = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";

  function run(): string | undefined {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
    (0, eval)(code);
    // unset = the stylesheet's default, light
    return theme() ?? "light";
  }

  it("is present", () => {
    expect(code).toContain("strength-log.settings");
  });

  it("reads the envelope settings.ts writes", () => {
    stubSystem(false);
    setSetting("appearance", "dark");
    expect(run()).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    setSetting("appearance", "light");
    expect(run()).toBe("light");
  });

  it("follows the system for 'system', like resolveTheme()", () => {
    setSetting("appearance", "system");
    stubSystem(true);
    expect(run()).toBe("dark");
    stubSystem(false);
    expect(run()).toBe("light");
  });

  it("agrees with settings.ts on stored envelopes it cannot use", () => {
    stubSystem(true);
    const raw = (v: string) => localStorage.setItem("strength-log.settings", v);
    // legacy / older envelope with no appearance key -> light (the default)
    raw(JSON.stringify({ v: 1, values: { unit: "kg" } }));
    expect(run()).toBe("light");
    // an envelope settings.ts rejects (no numeric v) must not paint dark first
    raw(JSON.stringify({ values: { appearance: "dark" } }));
    reloadSettings();
    expect(getSetting("appearance")).toBe("light");
    expect(run()).toBe("light");
    // garbage and unknown values
    raw("{not json");
    expect(run()).toBe("light");
    raw(JSON.stringify({ v: 2, values: { appearance: "sepia" } }));
    expect(run()).toBe("light");
    // a newer envelope is read as-is
    raw(JSON.stringify({ v: 99, values: { appearance: "dark" } }));
    expect(run()).toBe("dark");
  });

  it("leaves light when localStorage or matchMedia throw", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(run()).toBe("light");
    vi.stubGlobal("localStorage", new MemoryStorage());
    localStorage.setItem(
      "strength-log.settings",
      JSON.stringify({ v: 2, values: { appearance: "system" } }),
    );
    vi.stubGlobal("matchMedia", undefined);
    expect(run()).toBe("light");
  });
});

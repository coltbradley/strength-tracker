// Theme application: the ONE module that turns the Appearance setting into a
// painted theme. Everything else is CSS tokens (styles.css, the
// `:root[data-theme="dark"]` block) — no component knows which theme is active.
//
//   setting "light" | "dark" | "system"
//     -> resolveTheme(): "system" asks matchMedia('(prefers-color-scheme: dark)')
//     -> <html data-theme="light|dark"> + inline color-scheme
//     -> <meta name="theme-color"> rewritten from the resolved --paper token
//
// The theme-color value is READ from CSS (getComputedStyle), never written
// here, so a palette change stays a one-place edit in styles.css.
//
// COUPLING: index.html carries a tiny inline script that sets data-theme from
// the stored envelope before CSS paints (avoids a light flash on dark
// devices). It mirrors resolveTheme() for the stored value and must agree
// with it. startTheme() runs before first render in main.tsx and simply
// re-asserts the same answer.

import { getSetting, subscribeSettings, type Appearance } from "./settings";

export type Theme = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemQuery(): MediaQueryList | null {
  try {
    return typeof window !== "undefined" &&
      typeof window.matchMedia === "function"
      ? window.matchMedia(DARK_QUERY)
      : null;
  } catch {
    return null;
  }
}

/** The theme actually shown for a choice. Unknown/unsupported system -> light. */
export function resolveTheme(appearance: Appearance): Theme {
  if (appearance === "light" || appearance === "dark") return appearance;
  return systemQuery()?.matches ? "dark" : "light";
}

/** Set data-theme, color-scheme and the theme-color meta for one theme. */
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  syncThemeColorMeta();
}

/** Point <meta name="theme-color"> at the resolved --paper (read from CSS). */
function syncThemeColorMeta(): void {
  try {
    const paper = getComputedStyle(document.documentElement)
      .getPropertyValue("--paper")
      .trim();
    if (!paper) return; // stylesheet not loaded (tests, early boot): keep the meta
    let meta = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    meta.content = paper;
  } catch {
    // Decoration: a stale status-bar colour must never break startup.
  }
}

/**
 * Apply the current setting now and keep it applied: re-resolves when the
 * setting changes and, for "system", when the OS preference flips. Returns an
 * unsubscribe (tests, HMR). Call once, before first render.
 */
export function startTheme(): () => void {
  const mq = systemQuery();
  const update = (): void => applyTheme(resolveTheme(getSetting("appearance")));
  update();
  const offSettings = subscribeSettings(update);
  // The listener is attached regardless of the current choice and re-resolves
  // each time, so switching to "system" later needs no (re)subscription.
  mq?.addEventListener("change", update);
  return () => {
    offSettings();
    mq?.removeEventListener("change", update);
  };
}

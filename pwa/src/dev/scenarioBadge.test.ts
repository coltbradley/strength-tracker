// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { mountScenarioBadge } from "./scenarioBadge";
import { readFileSync } from "node:fs";

const styles = readFileSync("src/styles.css", "utf8");

afterEach(() => {
  document.getElementById("demo-scenario-badge")?.remove();
  delete document.documentElement.dataset.demoTextScale;
  delete document.documentElement.dataset.demoReducedMotion;
  window.history.replaceState(null, "", "/");
});

describe("DEV preview emulations", () => {
  it("exposes labeled text and reduced-motion emulations and keeps their URL state", () => {
    window.history.replaceState(null, "", "/?demo=versiond&demoTextScale=130&demoReducedMotion=1");
    mountScenarioBadge("versiond");

    const badge = document.getElementById("demo-scenario-badge");
    expect(badge?.textContent).toContain("DEMO · VERSIOND");
    expect(badge?.textContent).toContain("TEXT 130%");
    expect(badge?.textContent).toContain("MOTION ↓");
    expect(badge?.getAttribute("aria-label")).toContain("1.3 times text scale emulation");
    expect(badge?.getAttribute("aria-label")).toContain("reduced-motion emulation");
    expect(document.documentElement.dataset.demoTextScale).toBe("130");
    expect(document.documentElement.dataset.demoReducedMotion).toBe("true");
    expect(window.location.search).toContain("demoTextScale=130");
    expect(window.location.search).toContain("demoReducedMotion=1");
  });

  it("scales declared font sizes and applies the same motion limits as reduced motion", () => {
    const declarations = [...styles.matchAll(/font-size:\s*([^;}]+);/g)];
    expect(declarations.length).toBeGreaterThan(150);
    expect(declarations.some(([, value]) => value.includes("var(--demo-text-scale, 1) * var(--fs-"))).toBe(true);
    const relativeCodeRule = styles.match(/\.md code\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(relativeCodeRule).toMatch(/font-size:\s*0\.92em;/);
    expect(relativeCodeRule).not.toContain("var(--demo-text-scale, 1)");
    expect(styles).toContain(':root[data-demo-text-scale="130"]');

    const emulation = styles.match(/:root\[data-demo-reduced-motion="true"\][\s\S]*?\n  }/);
    expect(emulation?.[0]).toContain("animation-duration: 0.01ms !important");
    expect(emulation?.[0]).toContain("animation-iteration-count: 1 !important");
    expect(emulation?.[0]).toContain("transition-duration: 0.01ms !important");
    expect(emulation?.[0]).toContain("scroll-behavior: auto !important");
  });

  it("lets the Focus middle band scroll above the dock in short viewports", () => {
    // the middle takes the height left over and scrolls inside itself; it
    // never slides under the dock, at 320px or at 130% text
    expect(styles).toMatch(
      /\.focus-middle\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/,
    );
    expect(styles).toMatch(/\.focus-dock\s*\{[^}]*flex:\s*none;/);
  });
});

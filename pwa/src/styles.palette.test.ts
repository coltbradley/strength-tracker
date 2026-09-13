import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const viteConfig = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");

function tokensFrom(source: string): Record<string, string> {
  return Object.fromEntries(
    [...source.matchAll(/^\s*--([\w-]+)\s*:\s*([^;]+);/gm)].map(([, name, value]) => [
      name,
      value.trim(),
    ]),
  );
}

function ruleBody(source: string, selector: string): string {
  const marker = `${selector} {`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing CSS selector ${selector}`);

  const bodyStart = start + marker.length;
  const end = source.indexOf("}", bodyStart);
  if (end < 0) throw new Error(`Unclosed CSS selector ${selector}`);

  return source.slice(bodyStart, end);
}

describe("Warm Precision color tokens", () => {
  it("binds semantic light-theme roles to the approved palette", () => {
    const tokens = tokensFrom(styles);

    expect(tokens).toMatchObject({
      paper: "#f7f6fa",
      "paper-raised": "#fcfbfd",
      "paper-input": "#fcfbfd",
      cream: "#fcfbfd",
      "ink-rgb": "48 43 58",
      aubergine: "#57417f",
      "aubergine-press": "#463269",
      "current-set": "#855600",
      "completed-set": "#665f71",
      "control-outline": "#766e7b",
      text: "rgb(var(--ink-rgb))",
      "text-dim": "rgb(var(--ink-rgb) / 0.7)",
      bg: "var(--paper)",
      "bg-raised": "var(--paper-raised)",
      accent: "var(--aubergine)",
      "accent-press": "var(--aubergine-press)",
      "accent-dim": "var(--aubergine)",
      "control-border-color": "var(--control-outline)",
      "focus-set-current": "var(--current-set)",
      "focus-set-completed": "var(--completed-set)",
      "focus-set-completed-mark": "var(--cream)",
      "focus-set-future": "var(--control-outline)",
      danger: "var(--brick)",
      warn: "var(--accent-dim)",
      info: "var(--teal)",
      brick: "#a8321f",
      "plate-25": "#b2404a",
      "plate-20": "#4a6fb8",
      "plate-15": "#c9a227",
      "plate-10": "#3f8a5c",
      "plate-5": "#3a3f47",
      "plate-2h": "#9c4750",
      "plate-1h": "#8a8f97",
      "plate-steel": "#6f757e",
      "plate-collar": "#565b63",
    });
    expect(styles.match(/var\(--current-set\)/g)).toHaveLength(1);
    expect(tokens.brick).not.toBe(tokens.aubergine);
    expect(indexHtml).toContain('<meta name="theme-color" content="#f7f6fa" />');
    expect(viteConfig).toContain('background_color: "#f7f6fa"');
    expect(viteConfig).toContain('theme_color: "#f7f6fa"');
  });

  it("keeps raw current-set ochre inside its semantic token declaration", () => {
    expect(styles.match(/--current-set\s*:\s*#855600\s*;/gi)).toHaveLength(1);
    expect(styles.replace(/--current-set\s*:\s*#855600\s*;/gi, "")).not.toMatch(/#855600/i);
  });

  it("uses the semantic focus progress role in each state selector", () => {
    expect(ruleBody(styles, ".focus-set-segment")).toContain("var(--focus-set-future,");
    expect(ruleBody(styles, ".focus-set-segment--completed")).toContain(
      "var(--focus-set-completed,",
    );
    expect(ruleBody(styles, ".focus-set-segment--current")).toContain(
      "var(--focus-set-current,",
    );
  });
});

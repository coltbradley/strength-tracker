// Dev-only marker for a non-default demo scenario and its optional preview
// emulations. The ?demo= choice is remembered for router navigation, while
// text/motion modes stay explicit in the URL so a rendered check is repeatable.

import type { DemoScenario } from "./fixtures";

export function mountScenarioBadge(scenario: DemoScenario): void {
  if (scenario === "default") return;
  if (document.getElementById("demo-scenario-badge")) return;

  const query = new URLSearchParams(window.location.search);
  const textScale = query.get("demoTextScale") === "130";
  const reducedMotion = query.get("demoReducedMotion") === "1";
  if (textScale) document.documentElement.dataset.demoTextScale = "130";
  if (reducedMotion) document.documentElement.dataset.demoReducedMotion = "true";

  const badge = document.createElement("button");
  badge.id = "demo-scenario-badge";
  badge.type = "button";
  const modes = [
    ...(textScale ? ["TEXT 130%"] : []),
    ...(reducedMotion ? ["MOTION ↓"] : []),
  ];
  badge.textContent = `DEMO · ${scenario.toUpperCase()}${modes.length ? ` · ${modes.join(" · ")}` : ""}`;
  const modeDescription = [
    ...(textScale ? ["1.3 times text scale emulation"] : []),
    ...(reducedMotion ? ["reduced-motion emulation"] : []),
  ];
  badge.setAttribute(
    "aria-label",
    `Fake ${scenario} data${modeDescription.length ? `; ${modeDescription.join("; ")}` : ""}. Click to exit the demo.`,
  );
  badge.title = `Fake "${scenario}" data${modeDescription.length ? `; ${modeDescription.join("; ")}` : ""}. Click to return to the default demo data.`;

  Object.assign(badge.style, {
    position: "fixed",
    top: "0",
    left: "0",
    zIndex: "9999",
    maxWidth: "100vw",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    margin: "0",
    padding: "4px 8px",
    border: "0",
    borderBottomRightRadius: "4px",
    background: "var(--accent, #57417f)",
    color: "var(--text-inverse, #fcfbfd)",
    font: "600 10px/1.4 var(--font-mono, ui-monospace, monospace)",
    letterSpacing: "0.04em",
    textAlign: "left",
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);

  badge.addEventListener("click", () => {
    try {
      window.sessionStorage.removeItem("demoScenario");
    } catch {
      // private mode: the explicit ?demo=default below still wins
    }
    window.location.href = "/?demo=default";
  });

  const mount = () => document.body.appendChild(badge);
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
}

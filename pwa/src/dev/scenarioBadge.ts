// Dev-only marker for a non-default demo scenario.
//
// `readScenario` remembers the picked scenario in sessionStorage, because a
// router navigation drops the query string and the scenario has to survive it.
// The cost is that `?demo=offline` keeps applying to every later load of a
// bare `/`, and the app then renders a truthful-looking "offline — showing
// cached plan" with nothing on screen saying the offline is fabricated. That
// reads as a broken app, not as a scenario.
//
// So: whenever the active scenario is NOT the default, say so, and give it an
// exit. Nothing renders on `default`, which is what an unattended screenshot
// or overflow sweep runs. Styles are inline on purpose — styles.css is the
// production stylesheet and this element never ships (the whole src/dev/ tree
// is dead-code-eliminated unless VITE_DEMO=1).

import type { DemoScenario } from "./fixtures";

export function mountScenarioBadge(scenario: DemoScenario): void {
  if (scenario === "default") return;
  if (document.getElementById("demo-scenario-badge")) return;

  const badge = document.createElement("button");
  badge.id = "demo-scenario-badge";
  badge.type = "button";
  badge.textContent = `DEMO · ${scenario.toUpperCase()} ✕`;
  badge.title = `Fake "${scenario}" scenario — click to return to the default demo data`;

  Object.assign(badge.style, {
    position: "fixed",
    top: "0",
    left: "0",
    zIndex: "9999",
    margin: "0",
    padding: "4px 8px",
    border: "0",
    borderBottomRightRadius: "4px",
    background: "var(--burnt, #bd5410)",
    color: "var(--text-inverse, #fff9eb)",
    font: "600 10px/1.4 var(--font-mono, ui-monospace, monospace)",
    letterSpacing: "0.08em",
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

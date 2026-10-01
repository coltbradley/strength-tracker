// Vite plugin used ONLY by the live load-sync harness (e2e/live-load-sync.mjs).
//
// It patches the in-memory demo Supabase (src/dev/mockSupabase.ts) at transform
// time, so nothing in the repo's source changes and the same harness can be
// pointed at any checkout (main, a feature branch, the integrated branch):
//
//  1. The mock's v_resolved_prescriptions view drops entered_load/entered_unit.
//     The real view (20260924003054_native_load_units.sql) returns them, so
//     without this patch a kg-authored or lb-authored prescription can never
//     reach the app in the demo and the whole authored-load path is untested.
//  2. The mock's `engine` is private. Exposing it as window.__engine lets the
//     harness flip `offline` at the DATA layer (the mock never touches the
//     network, so context.setOffline alone does not make its calls fail).
//
// Each patch asserts its anchor exists and reports through `onPatch`; a patch
// that does not apply is a harness-fidelity warning in the report, not a crash.

const PATCHES = [
  {
    name: "resolved-view-entered-load",
    anchor: "        load_entry: p.load_entry ?? null,\n        // Column default",
    replace:
      "        load_entry: p.load_entry ?? null,\n" +
      "        entered_load: p.entered_load ?? null,\n" +
      "        entered_unit: p.entered_unit ?? null,\n" +
      "        // Column default",
  },
  {
    name: "expose-engine",
    anchor: 'const engine: Engine = { store, offline: scenario === "offline", log };',
    replace:
      'const engine: Engine = { store, offline: scenario === "offline", log };\n' +
      "  (window as unknown as Record<string, unknown>).__engine = engine;",
  },
];

export function liveDemoPlugin(onPatch = () => {}) {
  return {
    name: "live-load-sync-demo-fidelity",
    enforce: "pre",
    transform(code, id) {
      if (!id.split("?")[0].endsWith("/src/dev/mockSupabase.ts")) return null;
      let out = code;
      for (const p of PATCHES) {
        if (out.includes(p.anchor)) {
          out = out.replace(p.anchor, p.replace);
          onPatch({ name: p.name, applied: true });
        } else {
          onPatch({ name: p.name, applied: false });
        }
      }
      return { code: out, map: null };
    },
  };
}

// Vitest setup (NEW-SESS-1).
//
// Node 25+ ships a built-in `localStorage` / `sessionStorage` global that is
// unusable without --localstorage-file (it warns and reads back undefined).
// Vitest's jsdom environment does not overwrite a global that already exists,
// so under Node 26 a test's bare `localStorage.clear()` hit that stub instead
// of jsdom's Storage while CI on Node 22 passed. Where the global is not a
// working Storage, point it at jsdom's own; only if jsdom has none either does
// a small in-memory Storage stand in. A global that already works is never
// touched, and non-DOM test files (no `window`) are skipped entirely.

type StorageName = "localStorage" | "sessionStorage";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}

function works(s: unknown): s is Storage {
  try {
    return typeof (s as Storage | undefined)?.clear === "function";
  } catch {
    return false;
  }
}

if (typeof window !== "undefined") {
  const g = globalThis as unknown as Record<string, unknown> & {
    jsdom?: { window?: Record<string, unknown> };
  };
  for (const name of ["localStorage", "sessionStorage"] as StorageName[]) {
    let current: unknown;
    try {
      current = g[name];
    } catch {
      current = undefined;
    }
    if (works(current)) continue;
    const fromJsdom = g.jsdom?.window?.[name];
    Object.defineProperty(globalThis, name, {
      value: works(fromJsdom) ? fromJsdom : memoryStorage(),
      configurable: true,
      writable: true,
    });
  }
}

import type { Unit } from "./units";
import { cacheKeys, getDb } from "./db";

export type SessionPrefs = {
  unit?: Unit;
  entryOrder?: string[];
};

function validPrefs(value: unknown): SessionPrefs {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: SessionPrefs = {};
  if (source.unit === "kg" || source.unit === "lb") result.unit = source.unit;
  if (Array.isArray(source.entryOrder)) {
    const seen = new Set<string>();
    const keys: string[] = [];
    for (const key of source.entryOrder) {
      if (typeof key !== "string" || key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
    result.entryOrder = keys;
  }
  return result;
}

function key(ownerId: string, sessionId: string) {
  return cacheKeys.sessionPrefs(ownerId, sessionId);
}

export async function readSessionPrefs(
  ownerId: string,
  sessionId: string,
): Promise<SessionPrefs> {
  const db = await getDb();
  return validPrefs(await db.get("kv", key(ownerId, sessionId)));
}

/** Merge a partial session choice in one kv readwrite transaction. Keeping the
 *  raw object preserves fields added by newer app versions during a partial
 *  write from an older tab. IndexedDB serializes readwrite transactions, so
 *  unit and order patches cannot overwrite each other. */
export async function writeSessionPrefs(
  ownerId: string,
  sessionId: string,
  patch: Partial<SessionPrefs>,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!ownerId || !sessionId || !isCurrent()) return;
  const db = await getDb();
  if (!isCurrent()) return;
  const tx = db.transaction("kv", "readwrite");
  const prefsKey = key(ownerId, sessionId);
  const existing = await tx.store.get(prefsKey);
  const raw = existing && typeof existing === "object" && !Array.isArray(existing)
    ? existing as Record<string, unknown>
    : {};
  const cleanPatch = validPrefs(patch);
  const next = { ...raw, ...cleanPatch };
  if (Object.hasOwn(patch, "unit") && cleanPatch.unit === undefined) delete next.unit;
  if (Object.hasOwn(patch, "entryOrder") && cleanPatch.entryOrder === undefined) delete next.entryOrder;
  if (!isCurrent()) {
    tx.abort();
    await tx.done.catch(() => undefined);
    return;
  }
  await tx.store.put(next, prefsKey);
  await tx.done;
}

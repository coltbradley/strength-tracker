import { useSyncExternalStore } from "react";
import { outbox } from "../lib/sync";
import type { OutboxStatus } from "../lib/outbox";

export function useOutboxStatus(): OutboxStatus {
  return useSyncExternalStore(
    (fn) => outbox.subscribe(fn),
    () => outbox.getStatus(),
  );
}

// Two-tap destructive confirms share one arming pattern: the first tap arms
// a specific key, the second fires. Arming auto-expires so a stray armed red
// button can't sit there waiting for an accidental tap minutes later.

import { useCallback, useEffect, useRef, useState } from "react";

const DISARM_MS = 4000;

export function useArmed(): [string | null, (key: string | null) => void] {
  const [armed, setArmedState] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const setArmed = useCallback((key: string | null) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setArmedState(key);
    if (key !== null) {
      timer.current = window.setTimeout(() => setArmedState(null), DISARM_MS);
    }
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return [armed, setArmed];
}

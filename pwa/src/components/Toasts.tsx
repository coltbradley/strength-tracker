import { useEffect, useRef, useState } from "react";
import { onToast, type Toast } from "../lib/errors";

export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const live = timers.current;
    const off = onToast((t) => {
      setToasts((prev) => [...prev.slice(-2), t]);
      const timer = setTimeout(() => {
        live.delete(timer);
        setToasts((prev) => prev.filter((x) => x.id !== t.id));
      }, 4500);
      live.add(timer);
    });
    return () => {
      off();
      for (const timer of live) clearTimeout(timer);
      live.clear();
    };
  }, []);

  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        // Announced to screen readers: an error is an alert, the rest are
        // polite status. Without a role the app said nothing to VoiceOver.
        <div
          key={t.id}
          className={`toast toast-${t.kind}`}
          role={t.kind === "error" ? "alert" : "status"}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}

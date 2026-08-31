import { useEffect, useRef, useState } from "react";
import {
  BrowserRouter,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import { Login } from "./screens/Login";
import { Today } from "./screens/Today";
import { Session } from "./screens/Session";
import { History } from "./screens/History";
import { End } from "./screens/End";
import { Plan } from "./screens/Plan";
import { SyncStatus } from "./components/SyncStatus";
import { SettingsSheet } from "./components/SettingsSheet";
import { Toasts } from "./components/Toasts";
import { FabDock } from "./components/FabDock";
import { setSentryUser } from "./lib/errors";

function Shell({ userId }: { userId: string }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const topbar = useRef<HTMLElement>(null);
  const tabbar = useRef<HTMLElement>(null);

  // Publish the topbar's height so fixed overlays can sit UNDER it instead of
  // over it. Toasts are the caller: anchored to the viewport top they covered
  // the gear and the wordmark for the 4.5s a toast lives. Measured rather than
  // hard-coded because the height moves with the safe-area inset, the font and
  // the breakpoint's --gutter. Same idea as --kb in <Sheet>.
  useEffect(() => {
    const el = topbar.current;
    if (el === null) return;
    const publish = () =>
      document.documentElement.style.setProperty(
        "--topbar-h",
        `${el.getBoundingClientRect().height}px`,
      );
    publish();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Session runs its own footer + rest strip; End keeps its own buttons.
  // The tab bar exists only on the two tab routes.
  const inSession = location.pathname === "/session";
  const showTabs = !inSession && location.pathname !== "/end";

  // Same measure-and-publish trick as --topbar-h above, for the other end of
  // the screen: the tab bar sits in normal flow, so a fixed overlay (the bug
  // button) has no way to know how far up to start. Republished when the tab
  // bar mounts and unmounts, because its height is 0 on the routes without it.
  useEffect(() => {
    const el = tabbar.current;
    const set = (px: number) =>
      document.documentElement.style.setProperty("--tabbar-h", `${px}px`);
    if (el === null) {
      set(0);
      return;
    }
    const publish = () => set(el.getBoundingClientRect().height);
    publish();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showTabs]);

  return (
    <div className="shell">
      <header className="topbar" ref={topbar}>
        <button
          type="button"
          className="topbar-title"
          aria-label="go to Today"
          onClick={() => navigate("/")}
        >
          Strength Log
        </button>
        <div className="topbar-right">
          <SyncStatus />
          <button
            type="button"
            className="gear-btn"
            aria-label="settings"
            onClick={() => setSettingsOpen(true)}
          >
            ⚙
          </button>
        </div>
      </header>

      <main
        className={
          inSession
            ? "content content-session"
            : // The bug button floats over the bottom-right of this scroller.
              // Without the extra bottom padding the last row of a long list
              // (Today's exercise list, History) comes to rest underneath it
              // with its right-hand value covered.
              `content${showTabs ? " content-fab" : ""}`
        }
      >
        <Routes>
          <Route path="/" element={<Today />} />
          <Route path="/session" element={<Session />} />
          <Route path="/history" element={<History />} />
          <Route path="/end" element={<End />} />
          <Route path="/plan/:id" element={<Plan />} />
          <Route path="*" element={<Today />} />
        </Routes>
      </main>

      {showTabs && (
        <nav className="tabbar" ref={tabbar}>
          <NavLink
            to="/"
            end
            className={({ isActive }) => `tab ${isActive ? "tab-on" : ""}`}
          >
            Today
          </NavLink>
          <NavLink
            to="/history"
            className={({ isActive }) => `tab ${isActive ? "tab-on" : ""}`}
          >
            History
          </NavLink>
        </nav>
      )}

      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      {showTabs && <FabDock userId={userId} route={location.pathname} />}
      <Toasts />
    </div>
  );
}

export function App() {
  const { loading, session } = useAuth();
  const userId = session?.user?.id ?? null;

  // Sentry learns who an event belongs to on every auth transition, and
  // forgets on sign-out — the next person on this device is not the last one.
  useEffect(() => {
    setSentryUser(userId);
  }, [userId]);

  if (loading) {
    return (
      <div className="splash">
        <Toasts />
        STRENGTH LOG
      </div>
    );
  }

  if (!session) {
    return (
      <>
        <Toasts />
        <Login />
      </>
    );
  }

  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Shell userId={session.user.id} />
    </BrowserRouter>
  );
}

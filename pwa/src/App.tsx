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
import { OAuthConsent } from "./screens/OAuthConsent";
import { isConsentPath } from "./lib/oauthConsent";

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

  // Tab bar height, for the bottom padding that keeps the last row of a long
  // list clear of the floating dock.
  //
  // The DOCK does not read this: it measures its own floor in useFabDrag,
  // because an effect keyed on the route runs before the session footer has
  // mounted and the dock would sit on top of it.
  useEffect(() => {
    const set = (px: number) =>
      document.documentElement.style.setProperty("--tabbar-h", `${px}px`);
    const el = tabbar.current;
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
          aria-label="go to Train"
          onClick={() => navigate("/")}
        >
          SET
        </button>
        <div
          className="topbar-right"
          role="group"
          aria-label="Support and recovery"
        >
          <SyncStatus />
          <FabDock userId={userId} route={location.pathname} />
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

      <main className={inSession ? "content content-session" : "content"}>
        <Routes>
          <Route
            path="/"
            element={<Today userId={userId} presentation="train" />}
          />
          <Route
            path="/program"
            element={<Today userId={userId} presentation="program" />}
          />
          <Route path="/session" element={<Session />} />
          <Route path="/history" element={<History />} />
          <Route path="/end" element={<End />} />
          <Route path="/plan/:id" element={<Plan />} />
          <Route
            path="*"
            element={<Today userId={userId} presentation="train" />}
          />
        </Routes>
      </main>

      {showTabs && (
        <nav className="tabbar" ref={tabbar} aria-label="Primary navigation">
          <NavLink
            to="/"
            end
            className={({ isActive }) => `tab ${isActive ? "tab-on" : ""}`}
          >
            Train
          </NavLink>
          <NavLink
            to="/program"
            end
            className={({ isActive }) => `tab ${isActive ? "tab-on" : ""}`}
          >
            Program
          </NavLink>
          <NavLink
            to="/history"
            className={({ isActive }) => `tab ${isActive ? "tab-on" : ""}`}
          >
            Record
          </NavLink>
        </nav>
      )}

      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
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

  // MCP sign-in consent renders INSTEAD of the shell: no reconciliation, no
  // outbox flush, no nav. Signed-out visitors met Login above with the URL
  // intact, so they arrive here after entering their code.
  if (isConsentPath(window.location.pathname, import.meta.env.BASE_URL)) {
    return (
      <>
        <Toasts />
        <OAuthConsent email={session.user.email ?? null} />
      </>
    );
  }

  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      {/* Keyed by user, so a change of person REMOUNTS the whole shell.
          Supabase does not always emit SIGNED_OUT between two people on one
          phone — a token can simply expire and the next sign-in be somebody
          else (db.ts names this exact case when it clears the device cache).
          Without the key, React keeps every screen's state across that
          boundary: Today's program, week strip, DONE marks, RESUME banner and
          the coach's notes would all still be the previous person's, sitting
          under the new person's name. */}
      <Shell key={session.user.id} userId={session.user.id} />
    </BrowserRouter>
  );
}

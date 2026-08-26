import { useState } from "react";
import {
  BrowserRouter,
  NavLink,
  Route,
  Routes,
  useLocation,
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

function Shell() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const location = useLocation();
  // Session runs its own footer + rest strip; End keeps its own buttons.
  // The tab bar exists only on the two tab routes.
  const inSession = location.pathname === "/session";
  const showTabs = !inSession && location.pathname !== "/end";

  return (
    <div className="shell">
      <header className="topbar">
        <span className="topbar-title">Strength Log</span>
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

      <main className={inSession ? "content content-session" : "content"}>
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
        <nav className="tabbar">
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
      <Toasts />
    </div>
  );
}

export function App() {
  const { loading, session } = useAuth();

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
      <Shell />
    </BrowserRouter>
  );
}

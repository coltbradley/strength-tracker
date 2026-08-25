import { useState } from "react";
import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import { Login } from "./screens/Login";
import { Today } from "./screens/Today";
import { Session } from "./screens/Session";
import { History } from "./screens/History";
import { End } from "./screens/End";
import { SyncStatus } from "./components/SyncStatus";
import { SettingsSheet } from "./components/SettingsSheet";
import { Toasts } from "./components/Toasts";

export function App() {
  const { loading, session } = useAuth();
  const [settingsOpen, setSettingsOpen] = useState(false);

  if (loading) {
    return (
      <div className="splash">
        <Toasts />
        Strength Log
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
    <BrowserRouter>
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

        <main className="content">
          <Routes>
            <Route path="/" element={<Today />} />
            <Route path="/session" element={<Session />} />
            <Route path="/history" element={<History />} />
            <Route path="/end" element={<End />} />
            <Route path="*" element={<Today />} />
          </Routes>
        </main>

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

        <SettingsSheet
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
        <Toasts />
      </div>
    </BrowserRouter>
  );
}

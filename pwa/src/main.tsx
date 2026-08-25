import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { installGlobalHandlers, initSentry } from "./lib/errors";
import { outbox } from "./lib/sync";
import "./styles.css";

installGlobalHandlers();
void initSentry();
outbox.start(); // flush on app start + 'online' events

registerSW({ immediate: true });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import { defineConfig } from "@playwright/test";
import { loadLocalConfig } from "./local-config.mjs";

const local = await loadLocalConfig({
  envFile: process.env.PHASE2_E2E_CONFIG_FILE ?? new URL("../.env.e2e.local", import.meta.url),
  adminEnvFile: process.env.PHASE2_E2E_ADMIN_CONFIG_FILE ?? new URL("../.env.e2e.admin.local", import.meta.url),
});
const appPort = new URL(local.appUrl).port || "80";

export default defineConfig({
  testDir: ".",
  testMatch: "phase2.spec.mjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: local.appUrl,
    browserName: "chromium",
    headless: true,
    launchOptions: local.browserChannel ? { channel: local.browserChannel } : {},
    trace: "off",
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${appPort} --strictPort`,
    url: local.appUrl,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      VITE_SUPABASE_URL: local.supabaseUrl,
      VITE_SUPABASE_ANON_KEY: local.anonKey,
      VITE_APP_VERSION: "phase2-local-e2e",
    },
  },
});

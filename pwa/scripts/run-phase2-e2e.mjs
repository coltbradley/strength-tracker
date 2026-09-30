import { spawn } from "node:child_process";
import { loadLocalConfig } from "../e2e/local-config.mjs";

let local;
try {
  local = await loadLocalConfig({
    envFile: process.env.PHASE2_E2E_CONFIG_FILE ?? new URL("../.env.e2e.local", import.meta.url),
    adminEnvFile: process.env.PHASE2_E2E_ADMIN_CONFIG_FILE ?? new URL("../.env.e2e.admin.local", import.meta.url),
  });
} catch (error) {
  if (/must use loopback|must use http|must not contain credentials/.test(error.message)) {
    console.error(`Refusing E2E target: ${error.message}`);
    process.exit(2);
  }
  console.log(`NOT RUN: ${error.message}`);
  process.exit(3);
}

async function reachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

if (!(await reachable(`${local.supabaseUrl}/auth/v1/health`))) {
  console.log("NOT RUN: local Supabase is unavailable. Start it with `supabase start` and apply seeds with `supabase db reset`.");
  process.exit(3);
}
const cli = new URL("../node_modules/@playwright/test/cli.js", import.meta.url);
const child = spawn(process.execPath, [cli.pathname, "test", "--config=e2e/playwright.config.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    PHASE2_SERVICE_ROLE_KEY: "",
    VITE_SUPABASE_URL: local.supabaseUrl,
    VITE_SUPABASE_ANON_KEY: local.anonKey,
  },
  stdio: "inherit",
});
child.on("error", (error) => {
  console.error(`Could not start Playwright: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : code ?? 1;
});

import { readFile } from "node:fs/promises";

export function assertLoopbackUrl(value, label = "URL") {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid loopback HTTP URL`);
  }
  const host = url.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
    throw new Error(`${label} must use loopback; hosted targets are refused`);
  }
  if (url.protocol !== "http:") {
    throw new Error(`${label} must use http for the local Supabase stack`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not contain credentials`);
  }
  return url.origin;
}

async function readEnvFile(path) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  const values = {};
  for (const [index, raw] of contents.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`Invalid .env.e2e.local line ${index + 1}`);
    const key = line.slice(0, separator).trim();
    if (key === "PHASE2_SERVICE_ROLE_KEY" && String(path).endsWith(".env.e2e.local")) {
      throw new Error("Keep PHASE2_SERVICE_ROLE_KEY only in pwa/.env.e2e.admin.local.");
    }
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export async function loadLocalConfig({
  env = process.env,
  envFile = new URL("../.env.e2e.local", import.meta.url),
  adminEnvFile = new URL("../.env.e2e.admin.local", import.meta.url),
} = {}) {
  const fileValues = await readEnvFile(envFile);
  const supabaseUrl = env.PHASE2_SUPABASE_URL ?? fileValues.PHASE2_SUPABASE_URL ?? "";
  const anonKey = env.PHASE2_ANON_KEY ?? fileValues.PHASE2_ANON_KEY ?? "";
  if (!supabaseUrl || !anonKey) {
    throw new Error("Set PHASE2_SUPABASE_URL and PHASE2_ANON_KEY in pwa/.env.e2e.local.");
  }
  const safeSupabaseUrl = assertLoopbackUrl(supabaseUrl, "PHASE2_SUPABASE_URL");
  const appUrl = assertLoopbackUrl(env.PHASE2_APP_URL ?? fileValues.PHASE2_APP_URL ?? "http://127.0.0.1:5198", "PHASE2_APP_URL");
  // Read the privileged key only after every network target has passed the
  // loopback check. Keep it in a separate ignored file so parsing ordinary
  // test configuration cannot touch it by accident.
  const adminValues = await readEnvFile(adminEnvFile);
  const serviceRoleKey = adminValues.PHASE2_SERVICE_ROLE_KEY ?? "";
  if (!serviceRoleKey) {
    throw new Error("Set PHASE2_SERVICE_ROLE_KEY in pwa/.env.e2e.admin.local. Use only the local Supabase key.");
  }
  return {
    supabaseUrl: safeSupabaseUrl,
    anonKey,
    appUrl,
    serviceRoleKey,
    browserChannel: env.PHASE2_BROWSER_CHANNEL ?? fileValues.PHASE2_BROWSER_CHANNEL ?? undefined,
  };
}

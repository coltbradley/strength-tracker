import { getClient } from "./db.ts";

export type HealthPing = () => Promise<void>;

export const HEALTH_OK = {
  status: "ok",
  server: "strength-tracker",
  transport: "streamable-http",
} as const;

export const HEALTH_DOWN = {
  status: "unavailable",
  server: "strength-tracker",
  transport: "streamable-http",
} as const;

export async function defaultHealthPing(): Promise<void> {
  const client = getClient();
  const { error } = await client
    .from("mcp_tokens")
    .select("id", { head: true, count: "exact" })
    .limit(1);
  if (error) throw new Error("token store unreachable");
}

export async function mcpHealthStatus(
  ping: HealthPing = defaultHealthPing,
): Promise<200 | 503> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return 503;
  try {
    await ping();
    return 200;
  } catch {
    console.error(JSON.stringify({ msg: "health ping failed" }));
    return 503;
  }
}

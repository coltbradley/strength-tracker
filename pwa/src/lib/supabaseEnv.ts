const PLACEHOLDER_URL = "https://placeholder.supabase.co";
const PLACEHOLDER_KEY = "placeholder-anon-key";

export function assertProductionSupabaseEnv(
  url: string | undefined,
  anonKey: string | undefined,
  prod: boolean,
  demo: boolean,
): void {
  if (!prod || demo) return;
  if (!url || url === PLACEHOLDER_URL) {
    throw new Error("Production build is missing VITE_SUPABASE_URL");
  }
  if (!anonKey || anonKey === PLACEHOLDER_KEY) {
    throw new Error("Production build is missing VITE_SUPABASE_ANON_KEY");
  }
}

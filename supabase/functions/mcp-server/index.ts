// Supabase Edge Function entry point. All behaviour lives in lib/handler.ts so
// it can be exercised by protocol.test.ts without binding a port.
import { handleRequest } from "./lib/handler.ts";

Deno.serve(handleRequest);

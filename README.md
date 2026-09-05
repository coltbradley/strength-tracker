# mcp-server deploy bundle

A build artifact, not source. `index.js` is `supabase/functions/mcp-server`
bundled with `deno bundle --platform deno --minify`, with `zod`,
`@supabase/supabase-js`, `@sentry/deno` and `@modelcontextprotocol/sdk/*`
left external so the function's own `deno.json` import map resolves them.

It exists because the Supabase MCP `deploy_edge_function` tool takes file
contents inline and the 28-file source tree is too large for it, while a
100 KB minified file is too long to retype by hand without error. The deployed
entrypoint imports this file by COMMIT SHA (immutable) and the platform
bundler snapshots it at deploy time, so the running function never fetches
anything from here. See docs/deploy.md, "MCP server changed".

Rebuild and verify:

    cd supabase/functions/mcp-server
    deno bundle index.ts -o /tmp/index.js --platform deno --minify \
      --external=zod --external="@supabase/supabase-js" \
      --external="@sentry/deno" --external="@modelcontextprotocol/sdk/*"
    sha256sum /tmp/index.js   # must match the sha recorded in deploy.md

The next `supabase functions deploy mcp-server` (by hand or from deploy.yml)
replaces this with the real source tree, and this branch can be deleted.

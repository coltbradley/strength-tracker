import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { reportError } from "../lib/errors";

type Grant = { client: { id: string; name: string }; granted_at: string };
type Load =
  { kind: "loading" } | { kind: "failed" } | { kind: "ok"; grants: Grant[] };

const REVOKE_COPY_DELAYED =
  "Apps you signed in to with this account, like ChatGPT or Claude. Disconnecting stops their access within the hour.";

/**
 * MCP clients this person approved on the consent page. Server data, like
 * training maxes, so it sits with TRAINING rather than the device settings.
 * Renders nothing where the OAuth API is absent (the demo mock, older tests)
 * rather than a row that can only fail.
 */
export function ConnectedApps() {
  const oauth = supabase.auth.oauth;
  const available = typeof oauth?.listGrants === "function";
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await oauth.listGrants();
      if (cancelled) return;
      if (error || !data) {
        if (error) reportError(error, "oauth.listGrants");
        setLoad({ kind: "failed" });
        return;
      }
      setLoad({ kind: "ok", grants: data });
    })();
    return () => {
      cancelled = true;
    };
  }, [available, oauth]);

  if (!available) return null;

  const disconnect = async (clientId: string) => {
    const { error } = await oauth.revokeGrant({ clientId });
    if (error) {
      reportError(error, "oauth.revokeGrant");
      return;
    }
    setLoad((prev) =>
      prev.kind === "ok"
        ? {
            kind: "ok",
            grants: prev.grants.filter((g) => g.client.id !== clientId),
          }
        : prev,
    );
  };

  return (
    <section className="settings-group">
      <div className="field-label">CONNECTED APPS</div>
      {load.kind === "ok" && load.grants.length > 0 ? (
        load.grants.map((grant) => (
          <div key={grant.client.id} className="sheet-row">
            <span>{grant.client.name}</span>
            <button
              type="button"
              className="sheet-row-value sheet-row-btn"
              aria-label={`Disconnect ${grant.client.name}`}
              onClick={() => void disconnect(grant.client.id)}
            >
              DISCONNECT
            </button>
          </div>
        ))
      ) : (
        <div className="sheet-row">
          <span>Connected apps</span>
          <span className="sheet-row-value">
            {load.kind === "loading"
              ? "…"
              : load.kind === "failed"
                ? "COULDN'T LOAD"
                : "NONE"}
          </span>
        </div>
      )}
      <div className="microcopy">{REVOKE_COPY_DELAYED}</div>
    </section>
  );
}

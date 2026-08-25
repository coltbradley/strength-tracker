// Client-generated UUIDv4. sessions.id and sets.id have no DB default on
// purpose: outbox replay is only idempotent if the client owns the id.
export function uuid(): string {
  return crypto.randomUUID();
}

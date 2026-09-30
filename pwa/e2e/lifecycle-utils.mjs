export async function cleanupUsers(users, deleteUser) {
  const results = await Promise.allSettled(users.map((user) => deleteUser(user)));
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `Could not delete ${failures.length} of ${users.length} local Phase 2 test users`,
    );
  }
}

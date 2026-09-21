/** Client turns plus stored usage — what the model actually sees. */

export interface ThreadTurn {
  role: "user" | "assistant";
  text: string;
  attachments?: {
    kind: "image" | "pdf" | "text";
    media_type: string;
    name: string;
    data: string;
  }[];
}

export interface PriorTurn {
  prompt: string;
  response: string;
}

/** Last client-supplied user turn; ignores trailing forged assistant turns. */
export function lastClientUserTurn(
  client: ThreadTurn[],
): ThreadTurn | undefined {
  for (let i = client.length - 1; i >= 0; i--) {
    if (client[i]!.role === "user") {
      return client[i];
    }
  }
  return undefined;
}

export function threadForModel(
  client: ThreadTurn[],
  prior: PriorTurn[],
): ThreadTurn[] | { error: string; status: number } {
  const lastUser = lastClientUserTurn(client);
  if (!lastUser) {
    return { error: "Nothing to answer", status: 400 };
  }

  const thread: ThreadTurn[] = [];
  for (const row of prior) {
    thread.push({ role: "user", text: row.prompt });
    thread.push({ role: "assistant", text: row.response });
  }
  thread.push(lastUser);
  return thread;
}

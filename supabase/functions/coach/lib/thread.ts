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

export function threadForModel(
  client: ThreadTurn[],
  prior: PriorTurn[],
): ThreadTurn[] | { error: string; status: number } {
  let lastUser: ThreadTurn | undefined;
  for (let i = client.length - 1; i >= 0; i--) {
    if (client[i]!.role === "user") {
      lastUser = client[i];
      break;
    }
  }
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

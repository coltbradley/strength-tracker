/** Client turns plus stored usage — what the model actually sees. */
import { lifterWords } from "../memory-extract.ts";

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
    // record() stores the prompt as sent, which includes the per-turn context
    // envelope. Replaying it would feed the model up to 20 stale plans and
    // memory blocks at full input price; only the fresh turn carries context.
    const text = lifterWords(row.prompt);
    if (text.length === 0) continue; // nothing the lifter said: drop the pair
    thread.push({ role: "user", text });
    thread.push({ role: "assistant", text: row.response });
  }
  thread.push(lastUser);
  return thread;
}

// Just enough markdown for a coach's answer.
//
// The model writes markdown — bold lifts, bulleted plans, the odd heading —
// and the chat rendered it raw, so answers arrived full of asterisks. This
// parses the subset that actually appears into a STRUCTURE, which the
// component turns into elements.
//
// Structure, never HTML. The text comes from a model that has just read a
// coach's screenshot and a CSV someone uploaded; putting that through
// dangerouslySetInnerHTML would make prompt injection into script injection.
// There is no HTML anywhere in this path, so there is nothing to sanitise.
//
// No dependency, on purpose: the service worker precaches the whole bundle for
// offline use, and a markdown library is larger than the rest of the chat.

export type Inline =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "code"; text: string };

export type Block =
  | { type: "p"; content: Inline[] }
  | { type: "h"; level: 2 | 3; content: Inline[] }
  | { type: "ul"; items: Inline[][] }
  | { type: "ol"; items: Inline[][] }
  | { type: "pre"; text: string };

/**
 * Inline spans: **bold**, *italic*, `code`.
 *
 * One pass, longest-marker-first, so `**a**` is never read as two italics.
 * Unmatched markers stay literal — a lone asterisk in "3*5" is an asterisk,
 * not the start of something.
 */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  let i = 0;

  const flush = () => {
    if (text !== "") {
      out.push({ type: "text", text });
      text = "";
    }
  };

  while (i < src.length) {
    const rest = src.slice(i);
    const bold = /^\*\*([^*]+)\*\*/.exec(rest) ?? /^__([^_]+)__/.exec(rest);
    if (bold) {
      flush();
      out.push({ type: "bold", text: bold[1]! });
      i += bold[0].length;
      continue;
    }
    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      flush();
      out.push({ type: "code", text: code[1]! });
      i += code[0].length;
      continue;
    }
    const italic = /^\*([^*\n]+)\*/.exec(rest) ?? /^_([^_\n]+)_/.exec(rest);
    if (italic) {
      flush();
      out.push({ type: "italic", text: italic[1]! });
      i += italic[0].length;
      continue;
    }
    text += src[i];
    i += 1;
  }
  flush();
  return out;
}

/** Blocks: paragraphs, headings, bullet and numbered lists, fenced code. */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push({ type: "p", content: parseInline(para.join(" ").trim()) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Fenced code: taken verbatim, including the markers people forget to close
    if (/^```/.test(line.trim())) {
      flushPara();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i]!.trim())) {
        body.push(lines[i]!);
        i += 1;
      }
      blocks.push({ type: "pre", text: body.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flushPara();
      continue;
    }

    const heading = /^(#{2,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      blocks.push({
        type: "h",
        level: heading[1]!.length === 2 ? 2 : 3,
        content: parseInline(heading[2]!),
      });
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const type = bullet ? "ul" : "ol";
      const last = blocks[blocks.length - 1];
      const item = parseInline((bullet ?? numbered)![1]!);
      if (last && last.type === type) last.items.push(item);
      else blocks.push({ type, items: [item] } as Block);
      continue;
    }

    para.push(line.trim());
  }
  flushPara();
  return blocks;
}

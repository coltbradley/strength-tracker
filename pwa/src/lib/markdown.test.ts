import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown";

const text = (t: string) => ({ type: "text", text: t });

describe("inline", () => {
  it("bold", () => {
    expect(parseInline("drop the **last set**")).toEqual([
      text("drop the "),
      { type: "bold", text: "last set" },
    ]);
  });

  it("code, for ids and tool names", () => {
    expect(parseInline("id is `Face_Pull`")).toEqual([
      text("id is "),
      { type: "code", text: "Face_Pull" },
    ]);
  });

  it("does not read a set scheme as italics", () => {
    // "3*5" and "5 x 5" must survive: a lone asterisk is an asterisk.
    expect(parseInline("3*5 at 100")).toEqual([text("3*5 at 100")]);
  });

  it("bold is not mistaken for two italics", () => {
    expect(parseInline("**heavy**")).toEqual([{ type: "bold", text: "heavy" }]);
  });

  it("an unmatched marker stays literal", () => {
    expect(parseInline("weight * reps")).toEqual([text("weight * reps")]);
  });
});

describe("blocks", () => {
  it("splits paragraphs on blank lines and joins wrapped ones", () => {
    const b = parseMarkdown("one\nstill one\n\ntwo");
    expect(b).toHaveLength(2);
    expect(b[0]).toEqual({ type: "p", content: [text("one still one")] });
  });

  it("bullets become one list, not one list each", () => {
    const b = parseMarkdown("- a\n- b\n- c");
    expect(b).toHaveLength(1);
    expect(b[0]!.type).toBe("ul");
    expect((b[0] as { items: unknown[] }).items).toHaveLength(3);
  });

  it("numbered lists are their own kind", () => {
    const b = parseMarkdown("1. first\n2. second");
    expect(b[0]!.type).toBe("ol");
  });

  it("headings", () => {
    expect(parseMarkdown("## Deload")[0]).toEqual({
      type: "h",
      level: 2,
      content: [text("Deload")],
    });
  });

  it("fenced code is verbatim, markers and all", () => {
    const b = parseMarkdown("```\n- not a bullet\n**not bold**\n```");
    expect(b[0]).toEqual({
      type: "pre",
      text: "- not a bullet\n**not bold**",
    });
  });

  it("an unclosed fence still terminates", () => {
    expect(parseMarkdown("```\nabc")[0]).toEqual({ type: "pre", text: "abc" });
  });

  it("a real answer parses into what it looks like", () => {
    const b = parseMarkdown(
      "Here's this week:\n\n- **Sat** — squat\n- **Sun** — press\n\nPlus abs.",
    );
    expect(b.map((x) => x.type)).toEqual(["p", "ul", "p"]);
  });

  it("empty input produces nothing rather than an empty paragraph", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("   \n\n  ")).toEqual([]);
  });
});

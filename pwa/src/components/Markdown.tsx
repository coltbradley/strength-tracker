// Render parsed markdown as elements.
//
// Elements, never dangerouslySetInnerHTML. The text comes from a model that
// has just read an uploaded screenshot and someone's CSV; routing that through
// innerHTML would turn prompt injection into script injection. Nothing here
// touches HTML, so there is nothing to sanitise.
import { Fragment } from "react";
import { parseMarkdown, type Inline } from "../lib/markdown";

function Spans({ content }: { content: Inline[] }) {
  return (
    <>
      {content.map((s, i) => {
        if (s.type === "bold") return <strong key={i}>{s.text}</strong>;
        if (s.type === "italic") return <em key={i}>{s.text}</em>;
        if (s.type === "code") return <code key={i}>{s.text}</code>;
        return <Fragment key={i}>{s.text}</Fragment>;
      })}
    </>
  );
}

export function Markdown({ source }: { source: string }) {
  const blocks = parseMarkdown(source);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        switch (b.type) {
          case "h":
            return b.level === 2 ? (
              <h3 key={i} className="md-h">
                <Spans content={b.content} />
              </h3>
            ) : (
              <h4 key={i} className="md-h">
                <Spans content={b.content} />
              </h4>
            );
          case "ul":
            return (
              <ul key={i} className="md-list">
                {b.items.map((item, j) => (
                  <li key={j}>
                    <Spans content={item} />
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} className="md-list">
                {b.items.map((item, j) => (
                  <li key={j}>
                    <Spans content={item} />
                  </li>
                ))}
              </ol>
            );
          case "pre":
            return (
              <pre key={i} className="md-pre">
                {b.text}
              </pre>
            );
          default:
            return (
              <p key={i} className="md-p">
                <Spans content={b.content} />
              </p>
            );
        }
      })}
    </div>
  );
}

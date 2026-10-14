import { Fragment, type ReactNode, useMemo } from "react";
import { cn } from "@/lib/utils";
import { type Block, type Inline, parseMarkdown } from "./markdown";

/** Renders a link; the chat passes one that routes app paths through the router. */
export type LinkRenderer = (href: string, children: ReactNode, key: number) => ReactNode;

const defaultLink: LinkRenderer = (href, children, key) => (
  <a key={key} href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
    {children}
  </a>
);

function renderInline(nodes: Inline[], link: LinkRenderer): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.type) {
      case "text":
        return <Fragment key={i}>{n.text}</Fragment>;
      case "br":
        return <br key={i} />;
      case "code":
        return (
          <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
            {n.text}
          </code>
        );
      case "strong":
        return (
          <strong key={i} className="font-semibold">
            {renderInline(n.children, link)}
          </strong>
        );
      case "em":
        return <em key={i}>{renderInline(n.children, link)}</em>;
      case "link":
        return link(n.href, renderInline(n.children, link), i);
    }
  });
}

function renderBlock(b: Block, i: number, link: LinkRenderer): ReactNode {
  switch (b.type) {
    case "p":
      return <p key={i}>{renderInline(b.children, link)}</p>;
    case "h":
      return (
        <p key={i} className={cn("font-semibold", b.level === 1 && "text-base")}>
          {renderInline(b.children, link)}
        </p>
      );
    case "ul":
      return (
        <ul key={i} className="list-disc space-y-0.5 pl-5">
          {b.items.map((item, j) => (
            <li key={j}>{renderInline(item, link)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol key={i} start={b.start} className="list-decimal space-y-0.5 pl-5">
          {b.items.map((item, j) => (
            <li key={j}>{renderInline(item, link)}</li>
          ))}
        </ol>
      );
    case "code":
      return (
        <pre key={i} className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
          {b.text}
        </pre>
      );
    case "table":
      return (
        <div key={i} className="overflow-x-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr>
                {b.head.map((c, j) => (
                  <th key={j} className="px-2 py-1 text-left font-medium">
                    {renderInline(c, link)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r} className="border-t">
                  {row.map((c, j) => (
                    <td key={j} className="tabular px-2 py-1 align-top">
                      {renderInline(c, link)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export function MarkdownView({ source, renderLink = defaultLink, className }: { source: string; renderLink?: LinkRenderer; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return <div className={cn("space-y-2 break-words", className)}>{blocks.map((b, i) => renderBlock(b, i, renderLink))}</div>;
}

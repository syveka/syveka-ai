"use client";

import { useId, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import { useTranslations } from "next-intl";
import { FileText } from "lucide-react";

export type MessageCitation = { documentId: string; title: string };

/**
 * Private-use characters wrap a citation's number while the reply goes
 * through the Markdown parser; nothing a user or model types can produce one
 * (they are removed from the reply first).
 */
const CITE_OPEN = "\uE000";
const CITE_CLOSE = "\uE001";
const CITE_TOKEN = /\uE000(\d+)\uE001/g;
const ANY_CITE_CHAR = /[\uE000\uE001]/g;

/** Every `[doc:…]` marker, well-formed or not (never more than one line). */
const DOC_MARKER = /[ \t]*\[doc:([^\]\n]*)\]/gi;
/** A marker still being streamed at the end of the text (`[`, `[do`, `[doc:1234`). */
const PARTIAL_DOC_MARKER = /[ \t]*\[(?:d(?:o(?:c(?::[^\]\n]*)?)?)?)?$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Replaces the model's `[doc:<uuid>]` markers before rendering. A marker
 * becomes a numbered reference only when its id is one of the sources the
 * server attached to this message (validated against this turn's
 * tenant-scoped retrieval); any other marker -- unknown, invented or
 * malformed -- is removed, so a raw id is never shown or linked.
 */
export function withCitationTokens(
  text: string,
  citations: readonly MessageCitation[] | undefined,
  streaming = false,
): string {
  const numberById = new Map(
    (citations ?? []).map((c, i) => [c.documentId.toLowerCase(), i + 1] as const),
  );
  let result = text.replace(ANY_CITE_CHAR, "");
  if (streaming) result = result.replace(PARTIAL_DOC_MARKER, "");
  return result.replace(DOC_MARKER, (_marker, rawId: string) => {
    const id = rawId.trim().toLowerCase();
    const n = UUID.test(id) ? numberById.get(id) : undefined;
    return n ? `${CITE_OPEN}${n}${CITE_CLOSE}` : "";
  });
}

type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
};

function citationNodes(value: string): MdNode[] {
  const nodes: MdNode[] = [];
  let last = 0;
  for (const match of value.matchAll(CITE_TOKEN)) {
    if (match.index > last) nodes.push({ type: "text", value: value.slice(last, match.index) });
    nodes.push({
      type: "citation",
      data: { hName: "sup", hProperties: { dataCitation: match[1] } },
      children: [],
    });
    last = match.index + match[0].length;
  }
  if (last < value.length) nodes.push({ type: "text", value: value.slice(last) });
  return nodes;
}

function transformCitations(node: MdNode) {
  if (node.type === "code" || node.type === "inlineCode") {
    if (node.value) node.value = node.value.replace(CITE_TOKEN, "");
    return;
  }
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "text" && child.value?.includes(CITE_OPEN)) {
      return citationNodes(child.value);
    }
    transformCitations(child);
    return [child];
  });
}

/** Remark plugin: citation tokens in text become `<sup data-citation="n">`. */
function remarkCitations() {
  return (tree: object) => transformCitations(tree as MdNode);
}

/** Links only to absolute http(s) and mailto URLs; anything else is plain text. */
export function safeChatUrl(url: string): string {
  const safe = defaultUrlTransform(url.trim());
  return /^(https?:\/\/|mailto:)/i.test(safe) ? safe : "";
}

const ALLOWED_ELEMENTS = [
  "p",
  "br",
  "hr",
  "em",
  "strong",
  "ul",
  "ol",
  "li",
  "a",
  "code",
  "pre",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "sup",
];

const headingClass = "mb-1 mt-3 font-semibold first:mt-0";

/**
 * An assistant reply rendered as safe Markdown. Raw HTML is never
 * interpreted (it shows as text), images are dropped, links open only for
 * http(s)/mailto, and each block takes its own text direction (an Arabic
 * reply in a Finnish UI, or Latin text in the Arabic UI).
 */
export function MarkdownMessage({
  content,
  citations,
  streaming = false,
}: {
  content: string;
  citations?: readonly MessageCitation[];
  streaming?: boolean;
}) {
  const t = useTranslations("chat");
  // A plain fragment id per message (React's ids contain punctuation).
  const sourceIdPrefix = `reply${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const sourceId = (n: number) => `${sourceIdPrefix}-source-${n}`;

  const components: Components = {
    p: ({ children }) => (
      <p dir="auto" className="my-2 first:mt-0 last:mb-0">
        {children}
      </p>
    ),
    h1: ({ children }) => (
      <h3 dir="auto" className={`${headingClass} text-base`}>
        {children}
      </h3>
    ),
    h2: ({ children }) => (
      <h3 dir="auto" className={`${headingClass} text-base`}>
        {children}
      </h3>
    ),
    h3: ({ children }) => (
      <h4 dir="auto" className={`${headingClass} text-sm`}>
        {children}
      </h4>
    ),
    h4: ({ children }) => (
      <h4 dir="auto" className={`${headingClass} text-sm`}>
        {children}
      </h4>
    ),
    h5: ({ children }) => (
      <h4 dir="auto" className={`${headingClass} text-sm`}>
        {children}
      </h4>
    ),
    h6: ({ children }) => (
      <h4 dir="auto" className={`${headingClass} text-sm`}>
        {children}
      </h4>
    ),
    ul: ({ children }) => (
      <ul dir="auto" className="my-2 list-disc space-y-1 ps-5">
        {children}
      </ul>
    ),
    ol: ({ children, start }) => (
      <ol dir="auto" start={start} className="my-2 list-decimal space-y-1 ps-5">
        {children}
      </ol>
    ),
    li: ({ children }) => <li dir="auto">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote dir="auto" className="my-2 border-s-2 border-border ps-3 text-muted-foreground">
        {children}
      </blockquote>
    ),
    a: ({ href, children }) => {
      if (!href) return <span>{children}</span>;
      const external = /^https?:\/\//i.test(href);
      return (
        <a
          href={href}
          className="font-medium underline underline-offset-2"
          {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        >
          {children}
        </a>
      );
    },
    pre: ({ children }) => (
      <pre
        dir="ltr"
        className="my-2 max-w-full overflow-x-auto rounded-md bg-background/70 p-3 text-xs [&>code]:whitespace-pre [&>code]:bg-transparent [&>code]:p-0"
      >
        {children}
      </pre>
    ),
    code: ({ children }) => (
      <code dir="ltr" className="rounded bg-background/70 px-1 py-0.5 font-mono text-[0.85em]">
        {children}
      </code>
    ),
    sup: ({ node }) => {
      const n = Number(node?.properties?.dataCitation);
      const source = Number.isInteger(n) ? citations?.[n - 1] : undefined;
      if (!source) return null;
      return (
        <sup className="ms-0.5">
          <a
            href={`#${sourceId(n)}`}
            aria-label={t("citation", { number: n, title: source.title })}
            title={source.title}
            className="rounded px-0.5 text-[0.7rem] font-semibold text-primary no-underline hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {n}
          </a>
        </sup>
      );
    },
  };

  return (
    <>
      <div dir="auto" className="min-w-0 break-words [overflow-wrap:anywhere]">
        <ReactMarkdown
          remarkPlugins={[remarkCitations]}
          allowedElements={ALLOWED_ELEMENTS}
          unwrapDisallowed
          urlTransform={safeChatUrl}
          components={components}
        >
          {withCitationTokens(content, citations, streaming)}
        </ReactMarkdown>
        {streaming ? (
          <span aria-hidden className="animate-pulse">
            ▍
          </span>
        ) : null}
      </div>
      {citations && citations.length > 0 ? (
        <SourceList citations={citations} sourceId={sourceId} label={t("sources")} />
      ) : null}
    </>
  );
}

function SourceList({
  citations,
  sourceId,
  label,
}: {
  citations: readonly MessageCitation[];
  sourceId: (n: number) => string;
  label: ReactNode;
}) {
  const headingId = `${sourceId(0)}-heading`;
  return (
    <section aria-labelledby={headingId} className="mt-2 border-t border-border/50 pt-2">
      <h4 id={headingId} className="mb-1 text-xs font-medium text-muted-foreground">
        {label}
      </h4>
      <ol className="space-y-1">
        {citations.map((c, i) => (
          <li
            key={c.documentId}
            id={sourceId(i + 1)}
            className="flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground"
          >
            <span aria-hidden className="shrink-0 font-semibold tabular-nums">
              {i + 1}.
            </span>
            <FileText aria-hidden className="mt-px size-3 shrink-0" />
            <span dir="auto" className="min-w-0 break-words [overflow-wrap:anywhere]">
              {c.title}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

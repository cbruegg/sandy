import { Marked } from "marked";

const allowedTagNames = [
  "del",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "p",
  "a",
  "ul",
  "ol",
  "sup",
  "sub",
  "li",
  "b",
  "i",
  "u",
  "strong",
  "em",
  "s",
  "code",
  "hr",
  "br",
  "div",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "caption",
  "pre",
  "span",
  "img",
  "details",
  "summary",
] as const;
const htmlTagPattern = /<[^>]*>/g;
const safeLinkPattern = /^(?:https?|ftp|mailto|magnet):/i;
const matrixContentUriPattern = /^mxc:\/\/[^/]+\/.+/i;
const marked = new Marked({
  async: false,
  breaks: true,
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    image({ text }) {
      return escapeHtml(text);
    },
  },
});

export const matrixHtmlAllowedTags = [...allowedTagNames];

export type MatrixRenderedMarkdown = {
  body: string;
  formattedBody: string;
};

export function renderMatrixMarkdown(markdown: string): MatrixRenderedMarkdown {
  const normalized = normalizeMarkdownLineBreaks(markdown);
  const rawHtml = marked.parse(normalized, { async: false });
  return {
    body: normalized,
    formattedBody: sanitizeMatrixHtml(rawHtml).trim(),
  };
}

function sanitizeMatrixHtml(html: string): string {
  return html.replace(htmlTagPattern, (tag) => sanitizeMatrixHtmlTag(tag));
}

function sanitizeMatrixHtmlTag(tag: string): string {
  const closing = /^<\s*\//.test(tag);
  const name = tag.match(/^<\s*\/?\s*([A-Za-z0-9-]+)/)?.[1]?.toLowerCase();
  if (!name || !isAllowedTagName(name)) {
    return escapeHtml(tag);
  }

  if (name === "br") {
    return "<br>";
  }

  if (name === "hr") {
    return "<hr>";
  }

  if (closing) {
    return `</${name}>`;
  }

  if (name === "a") {
    const href = extractHtmlAttribute(tag, "href");
    if (href && safeLinkPattern.test(href)) {
      return sanitizeMatrixHtmlAttributes(tag, "a", ["target", "href"]);
    }
  }

  if (name === "span") {
    return sanitizeMatrixHtmlAttributes(tag, "span", ["data-mx-bg-color", "data-mx-color", "data-mx-spoiler", "data-mx-maths"]);
  }

  if (name === "div") {
    return sanitizeMatrixHtmlAttributes(tag, "div", ["data-mx-maths"]);
  }

  if (name === "img") {
    const src = extractHtmlAttribute(tag, "src");
    if (!src || !matrixContentUriPattern.test(src)) {
      return "";
    }

    return sanitizeMatrixHtmlAttributes(tag, "img", ["width", "height", "alt", "title", "src"]);
  }

  if (name === "ol") {
    const start = extractHtmlAttribute(tag, "start");
    if (start && /^\d+$/.test(start)) {
      return `<ol start="${start}">`;
    }
  }

  if (name === "code") {
    const className = extractHtmlAttribute(tag, "class");
    if (className?.startsWith("language-")) {
      return `<code class="${escapeHtmlAttribute(className)}">`;
    }
  }

  return `<${name}>`;
}

function sanitizeMatrixHtmlAttributes(tag: string, name: string, allowedAttributes: readonly string[]): string {
  const attributes = allowedAttributes
    .map((attribute) => {
      const value = extractHtmlAttribute(tag, attribute);
      return value === null ? null : `${attribute}="${escapeHtmlAttribute(value)}"`;
    })
    .filter((attribute): attribute is string => attribute !== null);

  return attributes.length === 0 ? `<${name}>` : `<${name} ${attributes.join(" ")}>`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function extractHtmlAttribute(tag: string, name: string): string | null {
  const pattern = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = tag.match(pattern);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function isAllowedTagName(name: string): name is typeof allowedTagNames[number] {
  return (allowedTagNames as readonly string[]).includes(name);
}

function normalizeMarkdownLineBreaks(markdown: string): string {
  return markdown.replaceAll("\r\n", "\n");
}

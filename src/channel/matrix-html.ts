import { Marked, type Tokens } from "marked";

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

// Element X on iOS currently does not render HTML tables
// (https://github.com/element-hq/element-x-ios/issues/1416). Keep Matrix's
// plain text body unchanged; Matrix delivery sends table images separately.
const renderMarkdownTablesWithoutHtmlTables = true;
const marked = createMatrixMarkdownRenderer(renderMarkdownTablesWithoutHtmlTables);
const tableMarked = createMatrixMarkdownRenderer(false);
const tableScreenshotEdgePadding = 4;

export const matrixHtmlAllowedTags = [...allowedTagNames];

export type MatrixRenderedMarkdown = {
  body: string;
  formattedBody: string;
};

export type MatrixRenderedTableImage = {
  data: Buffer;
  width: number;
  height: number;
  alt: string;
};

export type MatrixTableImageRenderer = (tableMarkdown: string, index: number) => Promise<MatrixRenderedTableImage | null>;

type BunWebView = {
  navigate(url: string): Promise<void>;
  evaluate(script: string): Promise<unknown>;
  resize(width: number, height: number): Promise<void>;
  screenshot(options: { format: "png"; encoding: "buffer" }): Promise<Buffer>;
  close(): void;
};

type BunWebViewConstructor = new(options: { width: number; height: number }) => BunWebView;

type BunWithWebView = typeof Bun & {
  WebView?: BunWebViewConstructor;
};

type MatrixMarkdownRenderOptions = {
  renderMarkdownTablesWithoutHtmlTables?: boolean;
};

export function renderMatrixMarkdown(markdown: string, options?: MatrixMarkdownRenderOptions): MatrixRenderedMarkdown {
  const normalized = normalizeMarkdownLineBreaks(markdown);
  const renderer = options?.renderMarkdownTablesWithoutHtmlTables === undefined
    ? marked
    : createMatrixMarkdownRenderer(options.renderMarkdownTablesWithoutHtmlTables);
  const rawHtml = renderer.parse(normalized, { async: false });
  return {
    body: normalized,
    formattedBody: sanitizeMatrixHtml(rawHtml).trim(),
  };
}

export async function renderMatrixMarkdownWithAttachedTableImages(
  markdown: string,
  attachTableImage: (image: MatrixRenderedTableImage, index: number) => Promise<void>,
  renderTableImage: MatrixTableImageRenderer,
): Promise<MatrixRenderedMarkdown> {
  const normalized = normalizeMarkdownLineBreaks(markdown);
  const tokens = marked.lexer(normalized);
  const formattedParts: string[] = [];
  let tableIndex = 0;

  for (const token of tokens) {
    if (token.type === "space") {
      continue;
    }
    if (token.type === "table") {
      const table = token as Tokens.Table;
      const tableImage = await renderTableImage(table.raw, tableIndex);
      if (!tableImage) {
        formattedParts.push(renderMarkdownTableWithoutHtmlTable(table));
        tableIndex += 1;
        continue;
      }
      await attachTableImage(tableImage, tableIndex);
      tableIndex += 1;
      formattedParts.push("<p><em>Table image attached separately.</em></p>");
      continue;
    }

    const raw = "raw" in token && typeof token.raw === "string" ? token.raw : "";
    if (raw.length > 0) {
      formattedParts.push(renderMatrixMarkdown(raw, { renderMarkdownTablesWithoutHtmlTables: false }).formattedBody);
    }
  }

  return {
    body: normalized,
    formattedBody: formattedParts.join("\n").trim(),
  };
}

export function containsMarkdownTable(markdown: string): boolean {
  const normalized = normalizeMarkdownLineBreaks(markdown);
  return marked.lexer(normalized).some((token) => token.type === "table");
}

function createMatrixMarkdownRenderer(renderTablesWithoutHtmlTables: boolean): Marked {
  const renderer = {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    image({ text }: Tokens.Image) {
      return escapeHtml(text);
    },
    ...(renderTablesWithoutHtmlTables ? { table: renderMarkdownTableWithoutHtmlTable } : {}),
  };

  return new Marked({
    async: false,
    breaks: true,
    gfm: true,
    renderer,
  });
}

function renderMarkdownTableWithoutHtmlTable(token: Tokens.Table): string {
  const headers = token.header.map((cell, index) => renderTableHeader(cell, index));
  const rows = token.rows.map((row) => renderMarkdownTableRow(headers, row));
  return rows.join("\n");
}

function renderMarkdownTableRow(headers: string[], row: Tokens.TableCell[]): string {
  const cells = row.map((cell, index) => {
    const label = headers[index] ?? `Column ${index + 1}`;
    const value = renderTableCellInline(cell);
    return `<strong>${label}:</strong> ${value}`;
  });

  return `<p>${cells.join("<br>\n")}</p>`;
}

function renderTableHeader(cell: Tokens.TableCell, index: number): string {
  const header = renderTableCellInline(cell).trim();
  return header.length === 0 ? `Column ${index + 1}` : header;
}

function renderTableCellInline(cell: Tokens.TableCell): string {
  return marked.parseInline(cell.text, { async: false });
}

export async function renderMarkdownTableWithWebView(tableMarkdown: string): Promise<MatrixRenderedTableImage | null> {
  const webViewConstructor = (Bun as BunWithWebView).WebView;
  if (!webViewConstructor) {
    throw new Error("Bun.WebView is unavailable in this Bun runtime.");
  }

  const view = new webViewConstructor({ width: 1280, height: 720 });
  try {
    await view.navigate(`data:text/html;charset=utf-8,${encodeURIComponent(buildTableScreenshotHtml(tableMarkdown))}`);
    const size = normalizeScreenshotSize(await view.evaluate(`(() => {
      const rect = document.body.getBoundingClientRect();
      return { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
    })()`));
    await view.resize(size.width, size.height);
    const data = await view.screenshot({ format: "png", encoding: "buffer" });
    const dimensions = readPngDimensions(data);
    if (!dimensions) {
      return null;
    }
    return {
      data,
      width: dimensions.width,
      height: dimensions.height,
      alt: "Markdown table",
    };
  } finally {
    view.close();
  }
}

function normalizeScreenshotSize(value: unknown): { width: number; height: number } {
  const size = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const width = typeof size["width"] === "number" && Number.isFinite(size["width"])
    ? size["width"]
    : 1280;
  const height = typeof size["height"] === "number" && Number.isFinite(size["height"])
    ? size["height"]
    : 720;
  return {
    width: Math.max(1, Math.min(16_384, Math.ceil(width) + tableScreenshotEdgePadding)),
    height: Math.max(1, Math.min(16_384, Math.ceil(height) + tableScreenshotEdgePadding)),
  };
}

function buildTableScreenshotHtml(tableMarkdown: string): string {
  const tableHtml = tableMarked.parse(tableMarkdown, { async: false });
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
html, body {
  margin: 0;
  padding: 0;
  background: transparent;
}
body {
  display: inline-block;
  padding: 12px;
  color: #1f2328;
  font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
}
table {
  border-spacing: 0;
  border-collapse: collapse;
  width: max-content;
  max-width: 1200px;
}
th, td {
  padding: 6px 13px;
  border: 1px solid #d0d7de;
  line-height: 1.5;
  vertical-align: top;
  white-space: pre-wrap;
}
tr:nth-child(2n) {
  background-color: #f6f8fa;
}
th {
  font-weight: 600;
}
</style>
</head>
<body>${tableHtml}</body>
</html>`;
}

function readPngDimensions(data: Buffer): { width: number; height: number } | null {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (data.length < 24 || !data.subarray(0, 8).equals(pngSignature)) {
    return null;
  }
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
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

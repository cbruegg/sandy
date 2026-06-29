import type { WebView } from "bun";
import { renderMatrixMarkdownTableHtml, type MatrixRenderedTableImage } from "./matrix-markdown.js";

const tableScreenshotEdgePadding = 4;
const maxTableScreenshotSize = 16_384;

type BunWithWebView = typeof Bun & {
  WebView?: typeof WebView;
};

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
    if (!size) {
      return null;
    }
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

function normalizeScreenshotSize(value: unknown): { width: number; height: number } | null {
  const size = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const width = typeof size["width"] === "number" && Number.isFinite(size["width"])
    ? size["width"]
    : 1280;
  const height = typeof size["height"] === "number" && Number.isFinite(size["height"])
    ? size["height"]
    : 720;
  const paddedWidth = Math.max(1, Math.ceil(width) + tableScreenshotEdgePadding);
  const paddedHeight = Math.max(1, Math.ceil(height) + tableScreenshotEdgePadding);
  if (paddedWidth > maxTableScreenshotSize || paddedHeight > maxTableScreenshotSize) {
    return null;
  }
  return {
    width: paddedWidth,
    height: paddedHeight,
  };
}

function buildTableScreenshotHtml(tableMarkdown: string): string {
  const tableHtml = renderMatrixMarkdownTableHtml(tableMarkdown);
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

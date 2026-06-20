const allowedTagNames = ["b", "i", "code", "pre"] as const;
const preservedBlockPattern = /(<pre>[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>)/g;

export const matrixHtmlAllowedTags = [...allowedTagNames];

export function sanitizeMatrixHtml(text: string): string {
  let result = escapeHtml(text);

  for (const tag of allowedTagNames) {
    result = result
      .replaceAll(`&lt;${tag}&gt;`, `<${tag}>`)
      .replaceAll(`&lt;/${tag}&gt;`, `</${tag}>`);
  }

  return renderMatrixLineBreaks(result);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderMatrixLineBreaks(html: string): string {
  const parts = html.split(preservedBlockPattern);
  return parts.map((part, index) => {
    if (index % 2 === 1) {
      return part;
    }
    return part
      .replaceAll("\r\n", "\n")
      .replaceAll("\\n", "\n")
      .replaceAll("\n", "<br>");
  }).join("");
}

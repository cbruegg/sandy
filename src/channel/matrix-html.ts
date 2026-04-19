const allowedTagNames = ["b", "i", "code", "pre"] as const;

export const matrixHtmlAllowedTags = [...allowedTagNames];

export function sanitizeMatrixHtml(text: string): string {
  let result = escapeHtml(text);

  for (const tag of allowedTagNames) {
    result = result
      .replaceAll(`&lt;${tag}&gt;`, `<${tag}>`)
      .replaceAll(`&lt;/${tag}&gt;`, `</${tag}>`);
  }

  return result;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

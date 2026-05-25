const allowedTagNames = ["b", "i", "code", "pre"] as const;

export const telegramHtmlAllowedTags = [...allowedTagNames];

const allowedTagPattern = new RegExp(`</?(?:${allowedTagNames.join("|")})>`, "g");

export function sanitizeTelegramHtml(text: string): string {
  const result: string[] = [];
  const openTags: Array<{ name: string; index: number }> = [];
  let nextTextStart = 0;

  for (const match of text.matchAll(allowedTagPattern)) {
    const rawTag = match[0];
    const matchIndex = match.index ?? 0;
    if (matchIndex > nextTextStart) {
      result.push(escapeHtml(text.slice(nextTextStart, matchIndex)));
    }

    const isClosing = rawTag.startsWith("</");
    const tagName = rawTag.slice(isClosing ? 2 : 1, -1);

    if (!isClosing) {
      openTags.push({ name: tagName, index: result.length });
      result.push(escapeHtml(rawTag));
    } else if (openTags.at(-1)?.name === tagName) {
      const openTag = openTags.pop();
      if (openTag) {
        result[openTag.index] = `<${tagName}>`;
      }
      result.push(`</${tagName}>`);
    } else {
      result.push(escapeHtml(rawTag));
    }

    nextTextStart = matchIndex + rawTag.length;
  }

  if (nextTextStart < text.length) {
    result.push(escapeHtml(text.slice(nextTextStart)));
  }

  return result.join("");
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

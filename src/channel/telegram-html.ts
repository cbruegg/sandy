import { marked } from "marked";

const allowedTagNames = ["b", "i", "code", "pre", "blockquote"] as const;

const allowedTagPattern = new RegExp(`</?(?:${allowedTagNames.join("|")})>`, "g");

type MarkdownToken = {
  type: string;
  raw?: string;
  text?: string;
  href?: string;
  tokens?: MarkdownToken[];
  items?: MarkdownListItemToken[];
  ordered?: boolean;
  start?: number;
  lang?: string;
};

type MarkdownListItemToken = {
  raw?: string;
  text?: string;
  tokens?: MarkdownToken[];
};

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

export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

export function renderTelegramMarkdownChunks(markdown: string, maxLength = TELEGRAM_MAX_MESSAGE_LENGTH - 1): string[] {
  const tokens = marked.lexer(markdown, { gfm: true, breaks: true }) as MarkdownToken[];
  const blocks = renderBlocks(tokens, maxLength);

  if (blocks.length === 0) {
    return [""];
  }

  const chunks: string[] = [];
  let currentChunk = "";

  for (const block of blocks) {
    if (block.length > maxLength) {
      throw new Error("Rendered Telegram block exceeded the maximum message length.");
    }

    const nextChunk = currentChunk.length === 0 ? block : `${currentChunk}\n\n${block}`;
    if (nextChunk.length <= maxLength) {
      currentChunk = nextChunk;
      continue;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }
    currentChunk = block;
  }

  if (currentChunk.length > 0 || chunks.length === 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function renderBlocks(tokens: MarkdownToken[], maxLength: number): string[] {
  const blocks: string[] = [];

  for (const token of tokens) {
    const renderedBlocks = renderTokenToBlocks(token, maxLength);
    for (const block of renderedBlocks) {
      if (block.length > 0) {
        blocks.push(block);
      }
    }
  }

  return blocks;
}

function renderTokenToBlocks(token: MarkdownToken, maxLength: number): string[] {
  switch (token.type) {
    case "space":
      return [];

    case "code":
      return splitCodeBlock(token.text ?? "", maxLength);

    case "list": {
      const listBlock = renderListBlock(token, maxLength);
      return splitTextBlock(listBlock, maxLength);
    }

    case "paragraph":
    case "text":
    case "heading":
    case "blockquote":
    case "html":
    case "hr": {
      const block = renderSimpleBlock(token, maxLength);
      return splitTextBlock(block, maxLength);
    }

    default: {
      const fallback = escapeHtml(token.raw ?? token.text ?? "");
      return fallback.length === 0 ? [] : splitTextBlock(fallback, maxLength);
    }
  }
}

function renderSimpleBlock(token: MarkdownToken, maxLength: number): string {
  if (token.type === "blockquote") {
    const inner = renderNestedBlocks(token.tokens ?? [], maxLength, "\n");
    const text = inner.length > 0 ? inner : escapeHtml(token.text ?? token.raw ?? "");
    return wrapTag("blockquote", text);
  }

  if (token.type === "hr") {
    return "---";
  }

  if (Array.isArray(token.tokens) && token.tokens.length > 0) {
    return renderInlineTokens(token.tokens);
  }

  return escapeHtml(token.text ?? token.raw ?? "");
}

function renderListBlock(token: MarkdownToken, maxLength: number): string {
  const items = token.items ?? [];
  const start = token.start ?? 1;

  return items.map((item, index) => {
    const prefix = token.ordered === true ? `${start + index}. ` : "- ";
    const itemBody = renderListItem(item, maxLength);
    return prefixMultiline(itemBody, prefix, "  ");
  }).join("\n");
}

function renderListItem(item: MarkdownListItemToken, maxLength: number): string {
  if (Array.isArray(item.tokens) && item.tokens.length > 0) {
    const rendered = renderNestedBlocks(item.tokens, maxLength, "\n");
    if (rendered.length > 0) {
      return rendered;
    }
  }

  return escapeHtml(item.text ?? item.raw ?? "");
}

function renderNestedBlocks(tokens: MarkdownToken[], maxLength: number, separator: string): string {
  const blocks = renderBlocks(tokens, maxLength);
  return blocks.join(separator);
}

function renderInlineTokens(tokens: MarkdownToken[]): string {
  return tokens.map((token) => renderInlineToken(token)).join("");
}

function renderInlineToken(token: MarkdownToken): string {
  switch (token.type) {
    case "text":
      if (Array.isArray(token.tokens) && token.tokens.length > 0) {
        return renderInlineTokens(token.tokens);
      }
      return escapeHtml(token.text ?? "");

    case "strong":
      return wrapTag("b", renderInlineTokens(token.tokens ?? []));

    case "em":
      return wrapTag("i", renderInlineTokens(token.tokens ?? []));

    case "codespan":
      return wrapTag("code", escapeHtml(token.text ?? ""));

    case "br":
      return "\n";

    case "link":
      return renderLinkLikeToken(token);

    case "image":
      return renderImageLikeToken(token);

    case "del":
      return renderInlineTokens(token.tokens ?? []);

    case "escape":
      return escapeHtml(token.text ?? token.raw ?? "");

    case "html":
      return escapeHtml(token.raw ?? token.text ?? "");

    default:
      if (Array.isArray(token.tokens) && token.tokens.length > 0) {
        return renderInlineTokens(token.tokens);
      }
      return escapeHtml(token.text ?? token.raw ?? "");
  }
}

function renderLinkLikeToken(token: MarkdownToken): string {
  const label = renderInlineTokens(token.tokens ?? []);
  const href = escapeHtml(token.href ?? "");

  if (label.length === 0) {
    return href;
  }

  if (href.length === 0 || label === href) {
    return label;
  }

  return `${label} (${href})`;
}

function renderImageLikeToken(token: MarkdownToken): string {
  const alt = renderInlineTokens(token.tokens ?? []);
  const href = escapeHtml(token.href ?? "");

  if (alt.length === 0) {
    return href;
  }

  if (href.length === 0) {
    return alt;
  }

  return `${alt} (${href})`;
}

function splitCodeBlock(text: string, maxLength: number): string[] {
  const wrapperLength = "<pre></pre>".length;
  const maxContentLength = maxLength - wrapperLength;

  if (maxContentLength <= 0) {
    throw new Error("Telegram message limit is too small for a code block.");
  }

  const rendered = renderPreBlock(text);
  if (rendered.length <= maxLength) {
    return [rendered];
  }

  const chunks: string[] = [];
  let current = "";

  for (const line of text.split("\n")) {
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (renderPreBlock(candidate).length <= maxLength) {
      current = candidate;
      continue;
    }

    if (current.length > 0) {
      chunks.push(renderPreBlock(current));
      current = "";
    }

    const escapedLine = escapeHtml(line);
    const lineParts = splitEscapedText(escapedLine, maxContentLength);
    for (const part of lineParts) {
      chunks.push(`<pre>${part}</pre>`);
    }
  }

  if (current.length > 0) {
    chunks.push(renderPreBlock(current));
  }

  return chunks;
}

function splitTextBlock(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitPoint = findSafeSplitPoint(remaining, maxLength);
    let emittedChunk = "";
    let nextRemaining = "";

    while (splitPoint > 0) {
      const chunk = remaining.slice(0, splitPoint);
      const { closedChunk, reopenedRemaining } = balanceInlineTags(chunk, remaining.slice(splitPoint));
      if (closedChunk.length <= maxLength && reopenedRemaining.length < remaining.length) {
        emittedChunk = closedChunk;
        nextRemaining = reopenedRemaining;
        break;
      }
      splitPoint = findSafeSplitPoint(remaining, splitPoint - 1);
    }

    if (emittedChunk.length === 0) {
      throw new Error("Unable to split rendered Telegram text within the maximum length.");
    }

    chunks.push(emittedChunk);
    remaining = nextRemaining;
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function balanceInlineTags(chunk: string, remaining: string): { closedChunk: string; reopenedRemaining: string } {
  const openTags = collectOpenTags(chunk);
  if (openTags.length === 0) {
    return { closedChunk: chunk, reopenedRemaining: remaining };
  }

  const closing = [...openTags].reverse().map((name) => `</${name}>`).join("");
  const reopening = openTags.map((name) => `<${name}>`).join("");

  return {
    closedChunk: chunk + closing,
    reopenedRemaining: reopening + remaining,
  };
}

function collectOpenTags(chunk: string): string[] {
  const openTags: string[] = [];

  for (const match of chunk.matchAll(allowedTagPattern)) {
    const rawTag = match[0];
    if (rawTag.startsWith("</")) {
      const tagName = rawTag.slice(2, -1);
      if (openTags.at(-1) === tagName) {
        openTags.pop();
      }
      continue;
    }

    openTags.push(rawTag.slice(1, -1));
  }

  return openTags;
}

function findSafeSplitPoint(text: string, maxLength: number): number {
  let candidate = maxLength;

  while (candidate > 0) {
    if (isInsideTag(text, candidate) || isInsideEntity(text, candidate) || isInsideSurrogatePair(text, candidate)) {
      candidate -= 1;
      continue;
    }
    break;
  }

  if (candidate <= 0) {
    candidate = maxLength;
    while (candidate < text.length && (isInsideTag(text, candidate) || isInsideEntity(text, candidate) || isInsideSurrogatePair(text, candidate))) {
      candidate += 1;
    }
    return candidate;
  }

  const newlineIndex = text.lastIndexOf("\n", candidate - 1);
  if (newlineIndex > candidate * 0.5) {
    return newlineIndex + 1;
  }

  const spaceIndex = text.lastIndexOf(" ", candidate - 1);
  if (spaceIndex > candidate * 0.5) {
    return spaceIndex + 1;
  }

  return candidate;
}

function splitEscapedText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const splitPoint = findSafeSplitPoint(remaining, maxLength);
    if (splitPoint <= 0 || splitPoint >= remaining.length) {
      throw new Error("Unable to split escaped Telegram text.");
    }
    chunks.push(remaining.slice(0, splitPoint));
    remaining = remaining.slice(splitPoint);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function renderPreBlock(text: string): string {
  return `<pre>${escapeHtml(text)}</pre>`;
}

function prefixMultiline(text: string, firstPrefix: string, continuationPrefix: string): string {
  const lines = text.split("\n");
  return lines.map((line, index) => `${index === 0 ? firstPrefix : continuationPrefix}${line}`).join("\n");
}

function wrapTag(tag: string, text: string): string {
  return text.length === 0 ? "" : `<${tag}>${text}</${tag}>`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function isInsideTag(text: string, index: number): boolean {
  const lastOpen = text.lastIndexOf("<", index - 1);
  const lastClose = text.lastIndexOf(">", index - 1);
  return lastOpen !== -1 && lastOpen > lastClose;
}

function isInsideEntity(text: string, index: number): boolean {
  const lastAmp = text.lastIndexOf("&", index - 1);
  const lastSemi = text.lastIndexOf(";", index - 1);
  return lastAmp !== -1 && lastAmp > lastSemi;
}

function isInsideSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) {
    return false;
  }
  const prev = text.charCodeAt(index - 1);
  const curr = text.charCodeAt(index);
  return prev >= 0xD800 && prev <= 0xDBFF && curr >= 0xDC00 && curr <= 0xDFFF;
}

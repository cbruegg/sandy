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

export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/**
 * Split sanitized Telegram HTML into chunks that stay under the
 * sendMessage character limit.
 *
 * - Never splits inside a tag, an HTML entity, or a surrogate pair.
 * - Re-opens tags that were left open at the end of a chunk.
 * - Prefers to split on a newline or space when available.
 * - Guarantees forward progress so the loop always terminates.
 */
export function splitTelegramHtml(text: string, maxLength = TELEGRAM_MAX_MESSAGE_LENGTH - 1): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitPoint = findSafeSplitPoint(remaining, maxLength);
    let emittedChunk = "";
    let nextRemaining = "";

    // Shrink until the closed chunk fits within maxLength AND we make
    // forward progress (the reopened remainder must be strictly shorter).
    while (splitPoint > 0) {
      const chunk = remaining.slice(0, splitPoint);
      const { closedChunk, reopenedRemaining } = balanceHtmlTags(chunk, remaining.slice(splitPoint));

      if (closedChunk.length <= maxLength && reopenedRemaining.length < remaining.length) {
        emittedChunk = closedChunk;
        nextRemaining = reopenedRemaining;
        break;
      }

      // If reopening the tags makes the next remaining as long as or longer
      // than the current remaining, forward progress is impossible via
      // the reopening strategy.  Bail to the fallback which closes tags
      // without reopening them.
      if (reopenedRemaining.length >= remaining.length) {
        break;
      }

      splitPoint = findSafeSplitPoint(remaining, splitPoint - 1);
    }

    // If preserving formatting across the boundary cannot make forward
    // progress, fall back to closing open tags in the current chunk without
    // reopening them in the next chunk. This degrades formatting continuity
    // for pathological inputs with too many nested tags, but it guarantees
    // termination and avoids duplicating the same remainder forever.
    if (emittedChunk.length === 0) {
      splitPoint = findSafeSplitPoint(remaining, maxLength);
      while (splitPoint > 0) {
        const chunk = remaining.slice(0, splitPoint);
        const closedChunk = closeOpenTags(chunk);
        if (closedChunk.length <= maxLength) {
          emittedChunk = closedChunk;
          nextRemaining = remaining.slice(splitPoint);
          break;
        }
        splitPoint = findSafeSplitPoint(remaining, splitPoint - 1);
      }

      if (emittedChunk.length === 0) {
        throw new Error("Unable to split Telegram HTML message within the maximum length.");
      }
    }

    chunks.push(emittedChunk);
    remaining = nextRemaining;
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function findSafeSplitPoint(text: string, maxLength: number): number {
  let candidate = maxLength;

  // Walk backwards until we are not inside a tag, entity, or surrogate pair
  while (candidate > 0) {
    if (isInsideTag(text, candidate) || isInsideEntity(text, candidate) || isInsideSurrogatePair(text, candidate)) {
      candidate -= 1;
      continue;
    }
    break;
  }

  if (candidate <= 0) {
    // Emergency fallback: find the first safe point after maxLength
    candidate = maxLength;
    while (candidate < text.length && (isInsideTag(text, candidate) || isInsideEntity(text, candidate) || isInsideSurrogatePair(text, candidate))) {
      candidate += 1;
    }
    return candidate;
  }

  // Prefer splitting on a newline or a space.
  // Search up to candidate - 1 so the returned split point never exceeds maxLength.
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

function balanceHtmlTags(chunk: string, remaining: string): { closedChunk: string; reopenedRemaining: string } {
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

function closeOpenTags(chunk: string): string {
  const openTags = collectOpenTags(chunk);
  if (openTags.length === 0) {
    return chunk;
  }
  const closing = [...openTags].reverse().map((name) => `</${name}>`).join("");
  return chunk + closing;
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
    } else {
      const tagName = rawTag.slice(1, -1);
      openTags.push(tagName);
    }
  }

  return openTags;
}

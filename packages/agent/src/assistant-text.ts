const THINKING_OPEN = "<thinking>";
const THINKING_CLOSE = "</thinking>";

function asciiCaseFold(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

function asciiEqualsIgnoreCase(value: string, marker: string, start: number): boolean {
  if (start < 0 || start + marker.length > value.length) return false;
  for (let index = 0; index < marker.length; index += 1) {
    if (
      asciiCaseFold(value.charCodeAt(start + index)) !==
      asciiCaseFold(marker.charCodeAt(index))
    ) return false;
  }
  return true;
}

function asciiIndexOfIgnoreCase(value: string, marker: string): number {
  const lastStart = value.length - marker.length;
  for (let start = 0; start <= lastStart; start += 1) {
    if (asciiEqualsIgnoreCase(value, marker, start)) return start;
  }
  return -1;
}

function trailingMarkerPrefixLength(value: string, marker: string): number {
  const max = Math.min(value.length, marker.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (asciiEqualsIgnoreCase(value, marker.slice(0, length), value.length - length)) {
      return length;
    }
  }
  return 0;
}

/**
 * Removes literal thinking blocks while preserving all other text. The small
 * pending suffix is what lets tags span provider delta boundaries.
 */
export class LiteralThinkingBlockFilter {
  private pending = "";
  private insideThinking = false;

  push(chunk: string): string {
    if (!chunk) return "";
    this.pending += chunk;
    let visible = "";

    while (this.pending) {
      const marker = this.insideThinking ? THINKING_CLOSE : THINKING_OPEN;
      const markerIndex = asciiIndexOfIgnoreCase(this.pending, marker);

      if (markerIndex >= 0) {
        if (!this.insideThinking) visible += this.pending.slice(0, markerIndex);
        this.pending = this.pending.slice(markerIndex + marker.length);
        this.insideThinking = !this.insideThinking;
        continue;
      }

      const retained = trailingMarkerPrefixLength(this.pending, marker);
      const safeLength = this.pending.length - retained;
      if (!this.insideThinking) visible += this.pending.slice(0, safeLength);
      this.pending = this.pending.slice(safeLength);
      break;
    }

    return visible;
  }

  finish(): string {
    const visible = this.insideThinking ? "" : this.pending;
    this.pending = "";
    this.insideThinking = false;
    return visible;
  }
}

export function stripLiteralThinkingBlocks(text: string): string {
  const filter = new LiteralThinkingBlockFilter();
  return filter.push(text) + filter.finish();
}

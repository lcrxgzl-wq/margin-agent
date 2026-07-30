const THINKING_OPEN = "<thinking>";
const THINKING_CLOSE = "</thinking>";

function trailingMarkerPrefixLength(value: string, marker: string): number {
  const max = Math.min(value.length, marker.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) return length;
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
      const normalized = this.pending.toLowerCase();
      const markerIndex = normalized.indexOf(marker);

      if (markerIndex >= 0) {
        if (!this.insideThinking) visible += this.pending.slice(0, markerIndex);
        this.pending = this.pending.slice(markerIndex + marker.length);
        this.insideThinking = !this.insideThinking;
        continue;
      }

      const retained = trailingMarkerPrefixLength(normalized, marker);
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

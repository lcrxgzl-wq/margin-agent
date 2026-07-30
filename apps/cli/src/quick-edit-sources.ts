export const QUICK_EDIT_SOURCE_TOTAL_CHARS = 64_000;
export const QUICK_EDIT_SOURCE_CHARS_PER_FILE = 12_000;

export type QuickEditSource = {
  relativePath: string;
  text: string;
  contentHash: string;
};

export type QuickEditSourceContext = {
  sourceRef: string;
  text: string;
};

/** Load bounded, auditable excerpts for one Quick Edit request. */
export async function buildQuickEditSourceContext(
  relativePaths: readonly string[],
  readSource: (relativePath: string) => Promise<QuickEditSource>,
): Promise<QuickEditSourceContext[]> {
  const context: QuickEditSourceContext[] = [];
  let remainingChars = QUICK_EDIT_SOURCE_TOTAL_CHARS;
  for (const relativePath of relativePaths) {
    if (remainingChars <= 0) break;
    const source = await readSource(relativePath);
    const end = Math.min(
      source.text.length,
      QUICK_EDIT_SOURCE_CHARS_PER_FILE,
      remainingChars,
    );
    if (end <= 0) continue;
    context.push({
      sourceRef: `${source.relativePath}#sha256=${source.contentHash}&chars=0-${end}`,
      text: source.text.slice(0, end),
    });
    remainingChars -= end;
  }
  return context;
}

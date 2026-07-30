import { describe, expect, it, vi } from "vitest";
import {
  buildQuickEditSourceContext,
  QUICK_EDIT_SOURCE_CHARS_PER_FILE,
  QUICK_EDIT_SOURCE_TOTAL_CHARS,
} from "./quick-edit-sources.js";

describe("buildQuickEditSourceContext", () => {
  it("allows up to 12k per file and 64k across the request", async () => {
    const paths = Array.from({ length: 7 }, (_, index) => `source-${index + 1}.txt`);
    const readSource = vi.fn(async (relativePath: string) => ({
      relativePath,
      text: "x".repeat(20_000),
      contentHash: "0123456789abcdef",
    }));

    const context = await buildQuickEditSourceContext(paths, readSource);

    expect(context.map((item) => item.text.length)).toEqual([
      QUICK_EDIT_SOURCE_CHARS_PER_FILE,
      QUICK_EDIT_SOURCE_CHARS_PER_FILE,
      QUICK_EDIT_SOURCE_CHARS_PER_FILE,
      QUICK_EDIT_SOURCE_CHARS_PER_FILE,
      QUICK_EDIT_SOURCE_CHARS_PER_FILE,
      4_000,
    ]);
    expect(context.reduce((total, item) => total + item.text.length, 0))
      .toBe(QUICK_EDIT_SOURCE_TOTAL_CHARS);
    expect(context.at(-1)?.sourceRef).toContain("&chars=0-4000");
    expect(readSource).toHaveBeenCalledTimes(6);
  });

  it("skips empty material without spending the total budget", async () => {
    const context = await buildQuickEditSourceContext(
      ["empty.txt", "notes.txt"],
      async (relativePath) => ({
        relativePath,
        text: relativePath === "empty.txt" ? "" : "usable",
        contentHash: "fedcba9876543210",
      }),
    );

    expect(context).toEqual([{
      sourceRef: "notes.txt#sha256=fedcba9876543210&chars=0-6",
      text: "usable",
    }]);
  });
});

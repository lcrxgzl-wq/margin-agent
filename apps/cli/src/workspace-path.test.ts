import { describe, expect, it } from "vitest";
import { workspacePathComparisonKey } from "./workspace-path.js";

describe("workspacePathComparisonKey", () => {
  it("folds case only for Windows filesystem comparisons", () => {
    expect(workspacePathComparisonKey("Sources/Notes.TXT", "win32")).toBe(
      workspacePathComparisonKey("Sources/notes.txt", "win32"),
    );
    expect(workspacePathComparisonKey("Sources/Notes.TXT", "linux")).not.toBe(
      workspacePathComparisonKey("Sources/notes.txt", "linux"),
    );
  });
});

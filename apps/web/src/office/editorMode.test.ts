import { EditorMode } from "@hufe921/canvas-editor";
import { describe, expect, it, vi } from "vitest";
import { officeEditorReadOnly, withInternalEditorEdit } from "./editorMode";

describe("officeEditorReadOnly", () => {
  it("temporarily locks edit mode while an async document operation is running", () => {
    expect(officeEditorReadOnly("edit", false)).toBe(false);
    expect(officeEditorReadOnly("edit", true)).toBe(true);
  });

  it("keeps the user's read mode locked after the operation ends", () => {
    expect(officeEditorReadOnly("read", true)).toBe(true);
    expect(officeEditorReadOnly("read", false)).toBe(true);
  });

  it("locks edit mode for the complete native save window", () => {
    expect(officeEditorReadOnly("edit", false, true)).toBe(true);
    expect(officeEditorReadOnly("edit", false, false)).toBe(false);
  });
});

describe("withInternalEditorEdit", () => {
  it("enters edit mode before the mutation selects its target", () => {
    let mode = EditorMode.READONLY;
    let range: string | null = "stale";
    const events: string[] = [];
    const command = {
      executeMode(nextMode: EditorMode) {
        events.push(`mode:${nextMode}`);
        if (nextMode !== mode) range = null;
        mode = nextMode;
      },
    };

    const result = withInternalEditorEdit(command, true, () => {
      range = "target";
      events.push(`insert:${range}`);
      return "written";
    });

    expect(result).toBe("written");
    expect(events).toEqual(["mode:edit", "insert:target", "mode:readonly"]);
    expect(mode).toBe(EditorMode.READONLY);
  });

  it("restores the author-facing mode when the mutation throws", () => {
    const executeMode = vi.fn();

    expect(() => withInternalEditorEdit(
      { executeMode },
      true,
      () => { throw new Error("mutation failed"); },
    )).toThrow("mutation failed");
    expect(executeMode.mock.calls).toEqual([
      [EditorMode.EDIT],
      [EditorMode.READONLY],
    ]);
  });
});

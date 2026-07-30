import { EditorMode } from "@hufe921/canvas-editor";

export type OfficeEditorMode = "edit" | "read";

type EditorModeCommand = {
  executeMode: (mode: EditorMode) => void;
};

export function officeEditorReadOnly(
  mode: OfficeEditorMode,
  busy: boolean,
  saving = false,
): boolean {
  return busy || saving || mode === "read";
}

export function withInternalEditorEdit<T>(
  command: EditorModeCommand,
  restoreReadOnly: boolean,
  mutation: () => T,
): T {
  command.executeMode(EditorMode.EDIT);
  try {
    return mutation();
  } finally {
    command.executeMode(restoreReadOnly ? EditorMode.READONLY : EditorMode.EDIT);
  }
}

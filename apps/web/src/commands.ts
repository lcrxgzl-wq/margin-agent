import {
  SelectionCommandSchema,
  type SelectionCommand,
  type SelectionCommandKind,
} from "@margin/domain";

export function buildSelectionCommand(
  kind: SelectionCommandKind,
  blockId: string,
  selectionText?: string,
  instruction?: string,
  options?: Pick<
    SelectionCommand,
    "selectionStart" | "selectionRanges" | "operation" | "targetLanguage" | "tableCell" | "blockIds"
  >,
): SelectionCommand {
  return SelectionCommandSchema.parse({
    kind,
    blockId,
    selectionText,
    instruction,
    ...options,
  });
}

import { lazy, memo } from "react";
import { isNativeDocx } from "../api";
import type { CanvasProps } from "./canvasTypes";

const OfficeCanvas = lazy(() =>
  import("./OfficeCanvas").then((module) => ({ default: module.OfficeCanvas })),
);
const MarkdownCanvas = lazy(() =>
  import("./MarkdownCanvas").then((module) => ({ default: module.MarkdownCanvas })),
);

function CanvasView(props: CanvasProps) {
  return isNativeDocx(props.document)
    ? <OfficeCanvas {...props} />
    : <MarkdownCanvas {...props} />;
}

// Data-only comparator: callback props must stay stable or be read via refs inside
// OfficeCanvas. Otherwise a memo cache hit keeps stale host handlers after upgrades.
export const Canvas = memo(
  CanvasView,
  (previous, next) =>
    previous.document === next.document &&
    previous.blocks === next.blocks &&
    previous.proposals === next.proposals &&
    previous.comments === next.comments &&
    previous.busy === next.busy &&
    previous.statusLine === next.statusLine &&
    previous.activeProposalId === next.activeProposalId &&
    previous.focusRequest === next.focusRequest &&
    previous.clearSelectionSignal === next.clearSelectionSignal,
);

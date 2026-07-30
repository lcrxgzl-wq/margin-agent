type Props = {
  visible: boolean;
  x: number;
  y: number;
  busy: boolean;
  minY?: number;
  editDisabled?: boolean;
  editDisabledReason?: string | null;
  translationLabel?: string;
  onRewrite: () => void;
  onTranslate: () => void;
  onDiscuss: () => void;
  onMore: () => void;
};

/** Floating toolbar above the current text selection. */
export function SelectionBubble({
  visible,
  x,
  y,
  busy,
  minY = 12,
  editDisabled = false,
  editDisabledReason,
  translationLabel = "翻译",
  onRewrite,
  onTranslate,
  onDiscuss,
  onMore,
}: Props) {
  if (!visible) return null;
  const left = Math.min(Math.max(12, x - 120), Math.max(12, window.innerWidth - 260));
  const preferredTop = y - 48 >= minY ? y - 48 : y + 18;
  const top = Math.min(
    Math.max(minY, preferredTop),
    Math.max(minY, window.innerHeight - 52),
  );
  return (
    <div className="sel-bubble" style={{ left, top }}>
      {editDisabledReason ? <span className="selection-limit" title={editDisabledReason}>不可编辑</span> : null}
      <button type="button" disabled={busy || editDisabled} title={editDisabledReason || undefined} onClick={onRewrite}>
        改写
      </button>
      <button type="button" disabled={busy} onClick={onTranslate}>
        {translationLabel}
      </button>
      <button type="button" disabled={busy} onClick={onDiscuss}>
        讨论
      </button>
      <button type="button" disabled={busy} aria-label="更多操作" title="润色、按指令改写等" onClick={onMore}>
        更多
      </button>
    </div>
  );
}

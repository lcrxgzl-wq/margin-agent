type Props = {
  x: number;
  y: number;
  translationLabel?: string;
  editDisabled?: boolean;
  editDisabledReason?: string | null;
  onRewrite: () => void;
  onRewriteDirected: () => void;
  onTranslate: () => void;
  onPolish: () => void;
  onDiscuss: () => void;
  onClose: () => void;
};

export function SelectionMenu({
  x,
  y,
  translationLabel = "翻译选区",
  editDisabled = false,
  editDisabledReason,
  onRewrite,
  onRewriteDirected,
  onTranslate,
  onPolish,
  onDiscuss,
  onClose,
}: Props) {
  const left = Math.min(x, window.innerWidth - 180);
  const top = Math.min(y, window.innerHeight - 180);
  return (
    <>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 80 }}
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div className="ctx-menu" style={{ left, top }}>
        {editDisabledReason ? <p className="selection-limit-menu">{editDisabledReason}</p> : null}
        <button type="button" disabled={editDisabled} title={editDisabledReason || undefined} onClick={onRewrite}>
          重写选区
        </button>
        <button type="button" disabled={editDisabled} title={editDisabledReason || undefined} onClick={onRewriteDirected}>
          按指令重写
        </button>
        <button type="button" disabled={editDisabled} title={editDisabledReason || undefined} onClick={onTranslate}>
          {translationLabel}
        </button>
        <button type="button" disabled={editDisabled} title={editDisabledReason || undefined} onClick={onPolish}>
          润色选区
        </button>
        <button type="button" onClick={onDiscuss}>
          讨论选区
        </button>
        <button type="button" onClick={onClose}>
          取消
        </button>
      </div>
    </>
  );
}

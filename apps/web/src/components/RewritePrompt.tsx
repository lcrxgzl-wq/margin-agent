import { useEffect, useRef, useState } from "react";
import { useDialogFocus } from "../dialogFocus";
import { submitEnterFrom } from "../ime";

type Props = {
  open: boolean;
  excerpt?: string;
  busy?: boolean;
  onCancel: () => void;
  onSubmit: (instruction: string) => void;
};

/** Compact dialog for directed selection rewrite. */
export function RewritePrompt({ open, excerpt, busy, onCancel, onSubmit }: Props) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useDialogFocus({
    active: open,
    containerRef: panelRef,
    initialFocusRef: inputRef,
    canClose: () => !busy,
    onEscape: onCancel,
  });

  useEffect(() => {
    if (open) setText("");
  }, [open]);

  if (!open) return null;

  const submit = () => {
    const instruction = text.trim();
    if (!instruction || busy) return;
    onSubmit(instruction);
  };

  return (
    <div className="rewrite-prompt-backdrop" role="presentation" onClick={busy ? undefined : onCancel}>
      <div
        ref={panelRef}
        className="rewrite-prompt"
        role="dialog"
        aria-modal="true"
        aria-label="按指令重写"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>按指令重写</h2>
        {excerpt ? <p className="rewrite-excerpt">「{excerpt}」</p> : null}
        <textarea
          ref={inputRef}
          rows={3}
          value={text}
          disabled={busy}
          placeholder="例如：更克制、补理论桥接、去掉口号式表述…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // IME composition Enter confirms a candidate; never submit.
            if (submitEnterFrom(e)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="rewrite-prompt-actions">
          <button type="button" className="btn ghost" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="btn send"
            disabled={busy || !text.trim()}
            onClick={submit}
          >
            生成修订
          </button>
        </div>
      </div>
    </div>
  );
}

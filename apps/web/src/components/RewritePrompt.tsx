import { useEffect, useRef, useState } from "react";

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

  useEffect(() => {
    if (!open) return;
    setText("");
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!open) return null;

  const submit = () => {
    const instruction = text.trim();
    if (!instruction || busy) return;
    onSubmit(instruction);
  };

  return (
    <div className="rewrite-prompt-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="rewrite-prompt"
        role="dialog"
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
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape") onCancel();
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

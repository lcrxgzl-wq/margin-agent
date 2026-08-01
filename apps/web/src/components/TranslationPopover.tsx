import { Check, Copy, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";

export type TranslationState = {
  anchor: { x: number; y: number };
  source: string;
  status: "loading" | "done" | "error";
  result?: string;
  error?: string;
};

export function TranslationPopover({
  translation,
  onClose,
}: {
  translation: TranslationState;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setCopied(false);
  }, [translation.result]);

  const left = Math.min(
    Math.max(12, translation.anchor.x - 180),
    Math.max(12, window.innerWidth - 360),
  );
  const top = Math.min(
    Math.max(12, translation.anchor.y - 24),
    Math.max(12, window.innerHeight - 220),
  );
  const copy = async () => {
    if (!translation.result) return;
    try {
      await navigator.clipboard.writeText(translation.result);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard may be unavailable; leave the text visible for manual copy */
    }
  };

  return (
    <div className="translation-popover" role="dialog" aria-label="翻译结果" style={{ left, top }}>
      <header className="translation-heading">
        <strong>{translation.status === "loading" ? "翻译中" : translation.status === "error" ? "翻译失败" : "翻译"}</strong>
        <button type="button" aria-label="关闭翻译" title="关闭" onClick={onClose}><X /></button>
      </header>
      <p className="translation-source">{translation.source}</p>
      <div className="translation-body">
        {translation.status === "loading" ? (
          <LoaderCircle className="spin" aria-label="加载中" />
        ) : translation.status === "error" ? (
          <p className="review-error" role="alert">{translation.error}</p>
        ) : (
          <p>{translation.result}</p>
        )}
      </div>
      {translation.status === "done" ? (
        <div className="translation-actions">
          <button type="button" onClick={copy}>{copied ? <Check /> : <Copy />}{copied ? "已复制" : "复制"}</button>
        </div>
      ) : null}
    </div>
  );
}

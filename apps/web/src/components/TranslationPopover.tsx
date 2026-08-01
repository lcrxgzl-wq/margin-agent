import { Check, Copy, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  clampFloatRect,
  defaultTranslationFloatRect,
  resizeFloatRectFromBottomRight,
  type FloatRect,
} from "../layoutGeometry";

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
  const [rect, setRect] = useState<FloatRect>(() => defaultTranslationFloatRect(
    translation.anchor,
    { width: window.innerWidth, height: window.innerHeight },
  ));
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    rect: FloatRect;
  } | null>(null);
  const resizeRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    rect: FloatRect;
  } | null>(null);

  useEffect(() => {
    setCopied(false);
  }, [translation.result]);

  useEffect(() => {
    setRect(defaultTranslationFloatRect(
      translation.anchor,
      { width: window.innerWidth, height: window.innerHeight },
    ));
  }, [translation.anchor.x, translation.anchor.y, translation.source]);

  useEffect(() => {
    const clamp = () => setRect((current) => clampFloatRect(
      current,
      { width: window.innerWidth, height: window.innerHeight },
    ));
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, []);

  const onHeaderPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      rect,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onHeaderPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const active = dragRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    setRect(clampFloatRect({
      ...active.rect,
      x: active.rect.x + event.clientX - active.startX,
      y: active.rect.y + event.clientY - active.startY,
    }, { width: window.innerWidth, height: window.innerHeight }));
  };
  const onHeaderPointerEnd = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      rect,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = resizeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    setRect(resizeFloatRectFromBottomRight(active.rect, {
      x: event.clientX - active.startX,
      y: event.clientY - active.startY,
    }, { width: window.innerWidth, height: window.innerHeight }));
  };
  const onResizePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId === event.pointerId) resizeRef.current = null;
  };

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
    <div className="translation-popover" role="dialog" aria-label="翻译结果" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
      <header
        className="translation-heading"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerEnd}
        onPointerCancel={onHeaderPointerEnd}
      >
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
      <div
        className="translation-resize"
        aria-hidden
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerEnd}
        onPointerCancel={onResizePointerEnd}
      />
    </div>
  );
}

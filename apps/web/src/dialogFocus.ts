import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Visible focusable descendants, in DOM order (skips hidden tab panels). */
export function focusableElements(container: ParentNode): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      !element.closest("[hidden]") && element.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * Pure focus-trap step: index of the element to focus next.
 * `current` is the index of document.activeElement inside the trap (-1 when
 * focus is outside); wraps in both directions. Exported for tests.
 */
export function nextFocusIndex(current: number, count: number, shiftKey: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return shiftKey ? count - 1 : 0;
  return shiftKey ? (current - 1 + count) % count : (current + 1) % count;
}

type Options = {
  /** Whether the dialog is currently shown. */
  active: boolean;
  containerRef: RefObject<HTMLElement | null>;
  /** Preferred initial focus target; falls back to the first focusable element. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Escape only closes when this returns true (e.g. not while saving). */
  canClose?: () => boolean;
  /** Called on Escape when canClose() passes. */
  onEscape?: () => void;
};

/**
 * Dialog focus discipline: initial focus on open, Tab/Shift+Tab trap,
 * Escape-when-safe, and focus restore to the invoking element on close.
 */
export function useDialogFocus({
  active,
  containerRef,
  initialFocusRef,
  canClose,
  onEscape,
}: Options) {
  // Inline closures change identity every render; read them via refs so the
  // trap/focus effect does not re-run (and restore focus) on each render.
  const canCloseRef = useRef(canClose);
  const onEscapeRef = useRef(onEscape);
  canCloseRef.current = canClose;
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => {
      const target = initialFocusRef?.current ?? focusableElements(container)[0];
      target?.focus();
    }, 30);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        const focusables = focusableElements(container);
        if (!focusables.length) return;
        const current = focusables.indexOf(
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : (null as unknown as HTMLElement),
        );
        const next = nextFocusIndex(current, focusables.length, event.shiftKey);
        if (next >= 0) {
          event.preventDefault();
          focusables[next]?.focus();
        }
        return;
      }
      if (event.key === "Escape" && canCloseRef.current?.() !== false) {
        event.stopPropagation();
        onEscapeRef.current?.();
      }
    };
    container.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      container.removeEventListener("keydown", onKeyDown);
      if (previous && previous.isConnected) previous.focus();
    };
  }, [active, containerRef, initialFocusRef]);
}
